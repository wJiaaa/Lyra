/**
 * Where secrets are kept, and why not in the OS keychain.
 *
 * The obvious place is `safeStorage` — the macOS Keychain, Windows DPAPI, a Linux keyring — and
 * that is where the forge tokens used to live. It cost more than it bought, for one reason that is
 * specific to how this app is shipped: the macOS builds are ad-hoc signed, so the app's designated
 * requirement is a hash of its own executable:
 *
 *     # designated => cdhash H"a2a46d81ea171721f80958eff53316b3e3fca8c9"
 *
 * A keychain entry's access control names that requirement. Every release is a new build, so every
 * release has a new hash, so every release is — as far as macOS is concerned — a different
 * application asking for someone else's secrets. What that looked like was signing in to GitHub
 * again after every update, and a keychain prompt to go with it. Windows and Linux are unaffected
 * (DPAPI keys off the user account, keyrings off the application name), so this was macOS paying
 * for a guarantee the other two got for free.
 *
 * The honest trade this makes instead:
 *
 * - **What it protects against.** A secret in `settings.json` travels: that file is synced, copied
 *   between machines, and pasted into bug reports, and it was world-readable at 0644 with the API
 *   keys in it. Nothing here is in a file that gets shared, and all of it is 0600.
 * - **What it does not.** The key sits next to the ciphertext. Anything that can read your home
 *   directory can read both. This is a smaller claim than the keychain's, and the settings page
 *   says so rather than implying otherwise.
 *
 * If this app is ever signed with a Developer ID the keychain becomes stable and worth returning
 * to. That is a one-line change to where `key()` gets its bytes; the format below does not care.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { plumeHome } from "../session/store.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import { withFileLock } from "../utils/file-lock.ts";

const KEY_FILE = () => join(plumeHome(), "vault.key");

/** AES-256-GCM: 32-byte key, 12-byte nonce, 16-byte tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The key, read once and kept.
 *
 * Generated on first use rather than at install time, so a profile that never stores a secret
 * never grows a key file — and so this works the same on a home directory restored from a backup
 * as on a fresh one.
 */
let cached: Buffer | null = null;
/**
 * The key being read or made, so callers that arrive together share one.
 *
 * Two first uses at once — a settings save sealing a provider key while a forge token is being
 * sealed — each generated a key and each wrote it. Through a shared temporary name one of them
 * failed; through unique names both would succeed, and the key left on disk would not be the one
 * half the secrets had been sealed with. That is found out on the next launch, as secrets that no
 * longer open.
 */
let pending: Promise<Buffer> | null = null;

function key(): Promise<Buffer> {
	if (cached) return Promise.resolve(cached);
	pending ??= loadOrMakeKey().finally(() => {
		pending = null;
	});
	return pending;
}

async function loadOrMakeKey(): Promise<Buffer> {
	const path = KEY_FILE();

	const existing = await readFile(path).catch(() => null);
	// A truncated or hand-edited key is replaced rather than used: a short key would throw on every
	// call, and the failure would surface as "all your secrets are corrupt" instead of "this key is".
	if (existing && existing.length === KEY_BYTES) return (cached = existing);

	const fresh = randomBytes(KEY_BYTES);
	await mkdir(plumeHome(), { recursive: true });
	await writeFileAtomic(path, fresh, { mode: 0o600 });
	return (cached = fresh);
}

/**
 * One secret, as a string that is safe to write down.
 *
 * `v1:` prefixed so a later format can be told apart from this one without guessing, and so a
 * value that is *not* ciphertext is recognisable as such rather than being fed to the decipher.
 */
export async function seal(value: string): Promise<string> {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", await key(), iv);
	const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/**
 * The secret back, or null when this key cannot open it.
 *
 * Null rather than a throw, because every caller turns it into the same thing — "this needs
 * entering again" — and that is both true and actionable where a decipher stack trace is neither.
 * It is reached when the key file was replaced, or when the ciphertext came from another machine.
 */
export async function unseal(sealed: string): Promise<string | null> {
	if (!sealed.startsWith("v1:")) return null;
	try {
		const raw = Buffer.from(sealed.slice(3), "base64");
		const decipher = createDecipheriv("aes-256-gcm", await key(), raw.subarray(0, IV_BYTES));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + 16));
		return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + 16)), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// The store the secrets live in
// ---------------------------------------------------------------------------

const FILE = () => join(plumeHome(), "credentials.json");

interface VaultFile {
	/** Sealed values, by an opaque key the caller chooses — `provider:<id>`, `forge:<id>`. */
	secrets: Record<string, string>;
}

let loaded: VaultFile | null = null;
/** 读进 `loaded` 时那个文件是哪一版：inode、修改时间、大小。 */
let loadedStamp = "";

/**
 * 文件现在是哪一版。每次写都是换名替换（`writeFileAtomic`），所以换一次 inode 就变一次。
 *
 * 不止这个进程写它：桌面端和命令行各自刷新 MCP 令牌、各自保存设置。只认第一次读到的那份的话，
 * 一个进程永远看不见另一个刚换来的令牌，拿着已经作废的刷新令牌再去换，换来 invalid_grant。
 */
async function stampOf(): Promise<string> {
	const info = await stat(FILE()).catch(() => null);
	return info ? `${info.ino}:${info.mtimeMs}:${info.size}` : "none";
}

async function read(): Promise<VaultFile> {
	const stamp = await stampOf();
	if (loaded && stamp === loadedStamp) return loaded;
	loadedStamp = stamp;
	const raw = await readFile(FILE(), "utf8").catch(() => null);
	if (!raw) return (loaded = { secrets: {} });
	try {
		const parsed = JSON.parse(raw) as { secrets?: unknown };
		const secrets: Record<string, string> = {};
		for (const [id, value] of Object.entries(parsed.secrets ?? {})) {
			if (typeof value === "string") secrets[id] = value;
		}
		return (loaded = { secrets });
	} catch {
		return (loaded = { secrets: {} });
	}
}

async function write(file: VaultFile): Promise<void> {
	loaded = file;
	await mkdir(plumeHome(), { recursive: true });
	await writeFileAtomic(FILE(), JSON.stringify(file, null, 2), { mode: 0o600 });
	loadedStamp = await stampOf();
}

/** Forget what was read. For tests, and for anything that rewrites the file behind this. */
export function resetVault(): void {
	loaded = null;
	loadedStamp = "";
	cached = null;
	pending = null;
}

/** The secret filed under `id`, or null when there is none or this key cannot open it. */
export async function secret(id: string): Promise<string | null> {
	const stored = (await read()).secrets[id];
	if (stored === undefined) return null;
	return unseal(stored);
}

/**
 * File secrets under their ids, in one write.
 *
 * Plural because the caller with something to store is `saveSettings`, which has every provider's
 * key at once — one write rather than one per provider, and no window in which half of them have
 * been saved. An empty value removes the entry rather than storing something meaningless.
 */
export function putSecrets(entries: Record<string, string>): Promise<void> {
	return serially(async () => {
		const file = await read();
	const secrets = { ...file.secrets };
		for (const [id, value] of Object.entries(entries)) {
			if (value) secrets[id] = await seal(value);
			else delete secrets[id];
		}
		await write({ secrets });
	});
}

/** Drop everything filed under ids this predicate rejects — used to forget removed providers. */
export function keepSecrets(keep: (id: string) => boolean): Promise<void> {
	return serially(async () => {
		const file = await read();
		const secrets: Record<string, string> = {};
		for (const [id, value] of Object.entries(file.secrets)) if (keep(id)) secrets[id] = value;
		if (Object.keys(secrets).length !== Object.keys(file.secrets).length) await write({ secrets });
	});
}

/**
 * Writes one after another — within this process, and across processes.
 *
 * Each write reads the file, changes its own entries and writes the whole thing back. Settings
 * saves were the only writer and already ran one at a time; MCP sign-in tokens are written from
 * wherever a connection refreshes them, at any moment. Two of those side by side each wrote back
 * a copy without the other's entry, and a token that had just been refreshed — its predecessor
 * already spent — was lost.
 *
 * The desktop app and the command line are two processes writing the same file the same way, so
 * the queue alone is not enough: the read-change-write also runs under a lock file next to it, and
 * the read inside it goes to the disk (`read` notices the file has changed under it).
 */
let writing: Promise<unknown> = Promise.resolve();
function serially(job: () => Promise<void>): Promise<void> {
	const run = writing.then(() => withFileLock(`${FILE()}.lock`, job, { staleMs: 10_000 }));
	writing = run.catch(() => {});
	return run;
}
