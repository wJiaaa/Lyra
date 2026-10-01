import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where a preview's files live.
 *
 * Deliberately not the workspace. A snake game written to demonstrate an idea is not part of
 * anyone's project: it would show up in `git status`, get committed by accident, and have to be
 * cleaned out by hand. These are conversation artifacts — they belong with the conversation,
 * under the app's own directory, and they go when it does.
 */
export function previewsHome(home: string): string {
	return join(home, "previews");
}

export interface PreviewFile {
	/** Relative to the preview root; `index.html` is what gets loaded. */
	path: string;
	content: string;
}

export interface PreviewRecord {
	id: string;
	sessionId: string;
	title: string;
	/** Absolute path to the directory holding the files. */
	dir: string;
	entry: string;
	createdAt: number;
}

/**
 * A session id as the one directory name it is meant to be.
 *
 * Ids reach these functions from IPC and the web bridge, and they are joined under the app's home
 * and then removed recursively: `..` or a separator in one would delete outside it.
 */
function sessionDir(root: string, sessionId: string): string {
	if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/\0:]/.test(sessionId)) throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
	return join(root, sessionId);
}

/** Rejects anything that would climb out of the preview's own directory. */
function safeRelative(path: string): string | null {
	const clean = path.replace(/^\/+/, "").trim();
	if (!clean || clean.includes("..") || clean.startsWith("~")) return null;
	// Backslashes would be a separator on Windows and a literal here; neither is wanted.
	return /^[\w./-]+$/.test(clean) ? clean : null;
}

/**
 * Write one preview and return where it went.
 *
 * Everything is written under a directory named for the preview, so a second preview in the
 * same conversation cannot overwrite the first — and so deleting one is deleting a directory.
 */
export async function writePreview(
	home: string,
	options: { id: string; sessionId: string; title: string; files: PreviewFile[]; entry?: string },
): Promise<PreviewRecord> {
	const dir = join(sessionDir(previewsHome(home), options.sessionId), options.id);
	await mkdir(dir, { recursive: true });

	let wrote = 0;
	for (const file of options.files) {
		const relative = safeRelative(file.path);
		if (!relative) continue;
		const target = join(dir, relative);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, file.content, "utf8");
		wrote++;
	}
	if (wrote === 0) throw new Error("没有可写入的文件");

	const entry = safeRelative(options.entry ?? "index.html") ?? "index.html";
	const record: PreviewRecord = {
		id: options.id,
		sessionId: options.sessionId,
		title: options.title,
		dir,
		entry,
		createdAt: Date.now(),
	};
	await writeFile(join(dir, ".preview.json"), JSON.stringify(record), "utf8");
	return record;
}

export async function readPreview(home: string, sessionId: string, id: string): Promise<PreviewRecord | null> {
	const dir = join(sessionDir(previewsHome(home), sessionId), id);
	const raw = await readFile(join(dir, ".preview.json"), "utf8").catch(() => null);
	if (!raw) return null;
	try {
		return { ...(JSON.parse(raw) as PreviewRecord), dir };
	} catch {
		return null;
	}
}

/** Everything a conversation produced, newest first. */
export async function listPreviews(home: string, sessionId: string): Promise<PreviewRecord[]> {
	const root = sessionDir(previewsHome(home), sessionId);
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const records: PreviewRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const record = await readPreview(home, sessionId, entry.name);
		if (record) records.push(record);
	}
	return records.sort((a, b) => b.createdAt - a.createdAt);
}

/** Removed with the conversation, since that is the only thing they belonged to. */
export async function removePreviews(home: string, sessionId: string): Promise<void> {
	await rm(sessionDir(previewsHome(home), sessionId), { recursive: true, force: true }).catch(() => {});
}

/**
 * The other half of what a conversation leaves behind.
 *
 * The scratch directory is where the model is told to put throwaway files instead of the user's
 * repository — sample data, a one-off script, output it needed to look at once. Same lifetime as
 * the previews, same reason, so they are cleaned up together rather than each being remembered
 * separately at every call site.
 */
export function scratchHome(home: string): string {
	return join(home, "scratch");
}

const SESSION_DIRS = [previewsHome, scratchHome];

/** Everything a conversation wrote outside the project, gone with the conversation. */
export async function removeSessionArtifacts(home: string, sessionId: string): Promise<void> {
	const dirs = SESSION_DIRS.map((where) => sessionDir(where(home), sessionId));
	await rm(join(home, "changes", createHash("sha256").update(sessionId).digest("hex")), { recursive: true, force: true });
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

/** As `prunePreviews`, over every kind of artifact. Returns how many directories were removed. */
export async function pruneSessionArtifacts(
	home: string,
	liveSessionIds: Set<string>,
	maxAgeMs?: number,
	now?: number,
): Promise<number> {
	let removed = await pruneUnder(join(home, "changes"), new Set([...liveSessionIds].map((id) => createHash("sha256").update(id).digest("hex"))), maxAgeMs, now);
	for (const where of SESSION_DIRS) removed += await pruneUnder(where(home), liveSessionIds, maxAgeMs, now);
	return removed;
}

/**
 * Drop previews from conversations that no longer exist, and anything older than the cutoff.
 *
 * Without this the directory only ever grows: every demo, sketch and half-finished game from
 * every conversation, kept forever because nothing ever said otherwise.
 */
export async function prunePreviews(
	home: string,
	liveSessionIds: Set<string>,
	maxAgeMs = 30 * 24 * 60 * 60 * 1000,
	now = Date.now(),
): Promise<number> {
	return pruneUnder(previewsHome(home), liveSessionIds, maxAgeMs, now);
}

async function pruneUnder(
	root: string,
	liveSessionIds: Set<string>,
	maxAgeMs = 30 * 24 * 60 * 60 * 1000,
	now = Date.now(),
): Promise<number> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	let removed = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sessionDir = join(root, entry.name);

		if (!liveSessionIds.has(entry.name)) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
			removed++;
			continue;
		}

		const info = await stat(sessionDir).catch(() => null);
		if (info && now - info.mtimeMs > maxAgeMs) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
			removed++;
		}
	}
	return removed;
}
