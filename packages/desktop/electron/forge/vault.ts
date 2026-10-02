/**
 * Where the accounts and their tokens are kept.
 *
 * This app avoided being a credential store for as long as it could — `gh` held the token, and
 * that was one less thing to be responsible for. Supporting four hosts and several identities ends
 * that: there is no CLI that holds a GitLab token and a Gitee token and a token for the company's
 * own Gitea, and asking somebody to install three of them would be worse than storing one.
 *
 * The token used to be encrypted by the OS keychain, and is not any more. That was the right
 * default and the wrong one for how this app is shipped: the macOS builds are ad-hoc signed, so
 * every release has a different code identity, and a keychain entry is bound to the identity that
 * created it. The effect was signing in to GitHub again after every single update. See
 * `config/vault.ts` in core for the measurement and the trade that replaces it.
 *
 * What still holds:
 *
 * - The token is never in `settings.json` — the file that is synced, copied between machines and
 *   pasted into bug reports.
 * - Both the token and the key that seals it are `0600`, in the app's own directory.
 * - It never crosses IPC. The renderer gets accounts without tokens; every call that needs one is
 *   made here.
 */

import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { plumeHome, writeFileAtomic } from "@plume/core";
import { seal, unseal } from "@plume/core";
import { parseAccounts } from "./accounts.ts";
import type { ForgeAccount } from "./types.ts";

interface StoredEntry {
	account: ForgeAccount;
	/** The token, sealed by core's vault. */
	token: string;
}

interface StoredFile {
	entries: StoredEntry[];
}

const FILE = () => join(plumeHome(), "forges.json");

/** Read once, kept in memory: every list refresh would otherwise be a disk read and a decrypt. */
let loaded: StoredFile | null = null;

/**
 * Whether what is in memory is the whole of what is on disk.
 *
 * False when the file could not be parsed, or when it held entries this build refused — a
 * hand-edited file, one written by a newer version, an account whose `baseUrl` no longer passes
 * validation. In every one of those cases the list in memory is *shorter than the truth*, and
 * writing it back is not saving, it is deleting.
 *
 * That is not hypothetical. This file was found holding `{"version":1,"entries":[]}` — 35 bytes,
 * where an account had been — because a read that came up empty was followed by an ordinary
 * write, and the write believed it. Nothing warned, and there was nothing left to recover from.
 */
let intact = true;

/**
 * Forget what was read, for tests that point `PLUME_HOME` somewhere else between cases.
 *
 * The cache is keyed on nothing — it assumes one home per process, which is true of the app and
 * false of a test file. Without this the second case reads the first one's accounts.
 */
export function resetForgeStore(): void {
	loaded = null;
	intact = true;
}

async function read(): Promise<StoredFile> {
	if (loaded) return loaded;
	const raw = await readFile(FILE(), "utf8").catch(() => null);
	// No file is an answer, not a failure: this profile has never signed in to anything.
	if (raw === null) {
		intact = true;
		return (loaded = { entries: [] });
	}

	try {
		const parsed = JSON.parse(raw) as { entries?: unknown[] };
		const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
		// The accounts go through the same validation as a hand-edited file, and an entry whose
		// account did not survive it is dropped along with its token — a token nobody can attribute
		// to a host is not a credential, it is a secret with no purpose.
		const kept: StoredEntry[] = [];
		for (const entry of entries as StoredEntry[]) {
			const [account] = parseAccounts([entry?.account]);
			if (account && typeof entry.token === "string") {
				kept.push({ account, token: entry.token });
			}
		}
		// Dropping a bad entry is right; forgetting that anything was dropped is what loses data.
		intact = kept.length === entries.length;
		if (!intact) {
			console.warn(`[forge] ${entries.length - kept.length} account(s) in forges.json were not readable by this build`);
		}
		return (loaded = { entries: kept });
	} catch {
		intact = false;
		console.warn("[forge] forges.json could not be parsed; it will be preserved rather than overwritten");
		return (loaded = { entries: [] });
	}
}

async function write(file: StoredFile): Promise<void> {
	const path = FILE();
	await mkdir(plumeHome(), { recursive: true });

	/*
	 * Never overwrite a file we could not fully read.
	 *
	 * Signing one account in must not delete another that this build merely failed to parse. The
	 * unreadable copy is moved aside instead of being replaced, so the tokens in it still exist —
	 * recoverable by hand, which is the difference between an inconvenience and a loss.
	 *
	 * Kept, not deleted: it holds credentials, and the point of this branch is that we do not
	 * understand its contents well enough to be sure they are worthless.
	 */
	if (!intact) {
		const aside = `${path}.unreadable-${Date.now()}`;
		await rename(path, aside).catch(() => {});
		console.warn(`[forge] the previous forges.json was kept at ${aside} rather than being overwritten`);
		intact = true;
	}

	loaded = file;
	// 0600 from the moment the temporary file exists, so the tokens are never readable by anyone else.
	await writeFileAtomic(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** The change in progress; the next one starts after it. See `change`. */
let changing: Promise<unknown> = Promise.resolve();

/**
 * Read, modify and write the file as one step, one change at a time.
 *
 * Every change reads the list, awaits sealing a token, and writes the list back. Two at once —
 * signing in to two hosts, or a token being resealed while another account is saved — both started
 * from the same list: the second write failed on the shared temporary name, or it succeeded and
 * dropped the first change, and an account that had signed in successfully was gone on the next
 * launch.
 */
function change<T>(body: () => Promise<T>): Promise<T> {
	const run = changing.then(body);
	changing = run.catch(() => {});
	return run;
}

export async function listAccounts(): Promise<ForgeAccount[]> {
	return (await read()).entries.map((entry) => entry.account);
}

export async function accountById(id: string): Promise<ForgeAccount | null> {
	return (await read()).entries.find((entry) => entry.account.id === id)?.account ?? null;
}

/** The secret for one account, opened. Null when there is no such account, or no opening it. */
export async function tokenFor(id: string): Promise<string | null> {
	const entry = (await read()).entries.find((e) => e.account.id === id);
	if (!entry) return null;
	return unseal(entry.token);
}

/** Save an account and its token, replacing whatever was filed under the same id. */
export function saveAccount(account: ForgeAccount, token: string): Promise<void> {
	return change(async () => {
		const file = await read();
		const entry: StoredEntry = { account, token: await seal(token) };

		const at = file.entries.findIndex((e) => e.account.id === account.id);
		const entries = [...file.entries];
		if (at < 0) entries.push(entry);
		else entries[at] = entry;
		await write({ entries });
	});
}

/** Change what is known about an account without touching its token. */
export function updateAccount(id: string, patch: Partial<ForgeAccount>): Promise<ForgeAccount | null> {
	return change(async () => {
		const file = await read();
		const at = file.entries.findIndex((e) => e.account.id === id);
		if (at < 0) return null;

		const account = { ...file.entries[at].account, ...patch, id };
		const entries = [...file.entries];
		entries[at] = { ...file.entries[at], account };
		await write({ entries });
		return account;
	});
}

export function removeAccount(id: string): Promise<void> {
	return change(async () => {
		const file = await read();
		const entries = file.entries.filter((entry) => entry.account.id !== id);
		if (entries.length !== file.entries.length) await write({ entries });
	});
}
