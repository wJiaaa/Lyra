/** Atomic, ordered side-chat snapshots, separate from the main transcript. */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { plumeHome, writeFileAtomic, type Message } from "@plume/core";

const writes = new Map<string, Promise<void>>();

function enqueue(path: string, write: () => Promise<void>): Promise<void> {
	const previous = writes.get(path) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(write);
	writes.set(path, next);
	void next.finally(() => { if (writes.get(path) === next) writes.delete(path); }).catch(() => {});
	return next;
}

function dir(): string {
	return join(plumeHome(), "sidechats");
}

/** 界面生成的 id：时间戳加随机数的 base36，按字面排序就是开出来的先后。 */
const SIDE_ID = /^[a-z0-9]{1,32}$/;

export function isSideId(sideId: unknown): sideId is string {
	return typeof sideId === "string" && SIDE_ID.test(sideId);
}

function checkSession(sessionId: string): void {
	// Snapshot reads are reachable over IPC before a live session is resolved.
	if (!sessionId || /[\\/\0:]/.test(sessionId)) throw new Error("Invalid side-chat session id");
}

function fileFor(sessionId: string, sideId: string): string {
	checkSession(sessionId);
	if (!isSideId(sideId)) throw new Error("Invalid side-chat id");
	return join(dir(), sessionId, `${sideId}.json`);
}

/**
 * 这个会话在磁盘上有存档的侧边聊天，按开出来的先后。
 *
 * 最早那一个排第一。从没开口的还没有存档，关掉的存档已经删了，两种都不在这里。
 */
export async function listSideChats(sessionId: string): Promise<string[]> {
	checkSession(sessionId);
	const folder = join(dir(), sessionId);
	// 等这个会话还在路上的写和删落定，不然刚关掉的那个会被读回来。
	await Promise.all(Array.from(writes).filter(([path]) => dirname(path) === folder).map(([, write]) => write.catch(() => {})));
	const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
	// 原子写落盘前的临时文件也在这个目录里，只认 `<id>.json`。
	const ids = names.sort().map((name) => name.endsWith(".json") ? name.slice(0, -".json".length) : "").filter(isSideId);
	// The default one is the first ever opened, whatever its name sorts as.
	return ids.includes(DEFAULT_SIDE_CHAT_ID) ? [DEFAULT_SIDE_CHAT_ID, ...ids.filter((id) => id !== DEFAULT_SIDE_CHAT_ID)] : ids;
}

export interface SideChatArchive { messages: Message[]; modelId?: string | null }

export async function loadSideChatSnapshot(sessionId: string, sideId = DEFAULT_SIDE_CHAT_ID): Promise<SideChatArchive> {
	const path = fileFor(sessionId, sideId);
	await writes.get(path);
	return readSnapshot(path);
}

async function readSnapshot(path: string): Promise<SideChatArchive> {
	const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
	if (!raw) return { messages: [] };
	try {
		const parsed: SideChatArchive = JSON.parse(raw);
		return { messages: Array.isArray(parsed.messages) ? parsed.messages : [],
			...(parsed.modelId === null || typeof parsed.modelId === "string" ? { modelId: parsed.modelId } : {}) };
	} catch { return { messages: [] }; }
}

export async function loadSideChat(sessionId: string, sideId = DEFAULT_SIDE_CHAT_ID): Promise<Message[]> {
	return (await loadSideChatSnapshot(sessionId, sideId)).messages;
}

/**
 * Write it out.
 *
 * Write-then-rename, so a crash midway leaves the previous version rather than half of this one —
 * through the shared helper, not a copy of its three lines. The copy renamed once: on Windows,
 * where antivirus opens every file that has just been written, the save after each message could
 * be refused for that moment and was reported as failed, and a failed write left its temporary
 * file behind. See `utils/atomic-write.ts` in core.
 */
export function saveSideChat(sessionId: string, messages: Message[], modelId?: string | null, sideId = DEFAULT_SIDE_CHAT_ID): Promise<void> {
	const path = fileFor(sessionId, sideId);
	// Serialize now, before the next message can mutate this array or any content blocks.
	const snapshot = messages.length > 0 || modelId !== undefined ? JSON.stringify({ messages, modelId }) : null;
	return enqueue(path, () => writeSnapshot(path, snapshot));
}

/** Transcript events preserve a model selection committed earlier in the same write queue. */
export function saveSideChatTranscript(sessionId: string, messages: Message[], defaultModelId: string | null, sideId = DEFAULT_SIDE_CHAT_ID): Promise<void> {
	const path = fileFor(sessionId, sideId);
	const serialized = JSON.stringify(messages);
	return enqueue(path, async () => {
		const previous = await readSnapshot(path);
		const modelId = previous.modelId === undefined ? defaultModelId : previous.modelId;
		await writeSnapshot(path, `{"messages":${serialized},"modelId":${JSON.stringify(modelId)}}`);
	});
}

async function writeSnapshot(path: string, snapshot: string | null): Promise<void> {
	if (snapshot === null) { await rm(path, { force: true }); return; }
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, snapshot);
}

/** Reset joins the same queue so an earlier save cannot resurrect the conversation. */
export function clearSideChat(sessionId: string, sideId = DEFAULT_SIDE_CHAT_ID): Promise<void> {
	return saveSideChat(sessionId, [], undefined, sideId);
}

/**
 * Everything this session's side chats left on disk, once the session itself is gone.
 *
 * Waits out the folder's queued writes first: a save still in flight would otherwise recreate the
 * folder right after it was removed.
 */
export async function removeSideChats(sessionId: string): Promise<void> {
	checkSession(sessionId);
	const folder = join(dir(), sessionId);
	await Promise.all(Array.from(writes).filter(([path]) => dirname(path) === folder).map(([, write]) => write.catch(() => {})));
	await rm(folder, { recursive: true, force: true });
}

/** Folders whose session no longer exists: one deleted while the app was not running to follow it. */
export async function pruneSideChats(liveSessionIds: Set<string>): Promise<void> {
	const names = await readdir(dir()).catch(() => [] as string[]);
	await Promise.all(names.filter((name) => !liveSessionIds.has(name)).map((name) => rm(join(dir(), name), { recursive: true, force: true }).catch(() => {})));
}
