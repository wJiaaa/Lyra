/**
 * What goes into the prompt as memory — and recorded as having gone.
 *
 * Two stores with different scopes and different trust: the user's own preferences from
 * `~/.lyra/memory.json`, and this project's memory (what `learn` wrote, what background
 * extraction wrote).
 *
 * 会话内冻结，压缩、撤回、重新载入会话时刷新。以前每轮从磁盘读，理由是 `learn` 在会话中途写文件，
 * 缓存下来模型会「以为没学到」。这个理由在会话内不成立：`learn` 的调用和结果就在历史里，模型看得
 * 到自己刚记下了什么。它唯一失效的时候是那段历史被摘要掉或被撤回——正是这里刷新的时候。而每轮
 * 重读的代价是每次 `learn`（以及后台抽取写 `MEMORY.md`）都改 system prompt，整段对话的缓存重写
 * 一遍。边界：人在设置里删改记忆会立即作废快照（`invalidateMemorySnapshots`）；手工编辑文件、
 * 其他会话或子代理的 `learn` 要到下一次刷新才进来。
 *
 * 记忆是 system prompt 里的两个段落（`userMemory`、`projectMemory`），和其余段落一样随整份提示词
 * 在会话内冻结（`prompt/update.ts`）。这里的快照管的是「多久重读一次磁盘」：压缩时整份提示词重新
 * 生成，读到的新记忆直接进开头；撤回、重新载入和设置里的删改之后读到的不一样，就作为一条增量接在
 * 历史末尾，不重写开头。没有这层快照，每次 `learn` 都会让下一轮多一条整段记忆的增量。
 *
 * Pulled out of the turn so it can be tested without one: the turn is a hundred other things.
 */

import { readExtractedMemory } from "./memory-extract.ts";
import { EXTRACTED_KEY, markInjected, projectInjectedPath, userInjectedPath } from "./memory-injected.ts";
import { formatMemoryForPrompt, loadMemory, memorySnapshots } from "./memory.ts";
import { formatProjectMemorySources, projectMemoryDir, readLessons } from "./project-memory.ts";
import { join } from "node:path";

export interface GatheredMemory {
	/** `<user_memory>…</user_memory>`, or empty. */
	memorySnippet: string;
	/** The project's lessons and extracted memory, formatted, or empty. */
	projectMemory: string;
	projectMemoryFiles: { path: string; content: string }[];
}

interface MemorySnapshot {
	memory: GatheredMemory;
	userKeys: string[];
	projectKeys: string[];
}

/** 快照的键：会话之外还带上目录和开关，换了项目或关掉记忆都不会拿到别处的快照。 */
function snapshotKey(scope: string, cwd: string, enabled: boolean, projectEnabled: boolean): string {
	return `${scope}\0${cwd}\0${enabled}\0${projectEnabled}`;
}

/** 这个会话下一次组装提示词时重新读记忆。压缩、撤回、重新载入时由 `SessionLog` 调。 */
export function refreshMemorySnapshot(scope: string): void {
	for (const key of memorySnapshots.keys()) if (key.startsWith(`${scope}\0`)) memorySnapshots.delete(key);
}

export async function gatherMemory(cwd: string, enabled: boolean, now = Date.now(), projectEnabled = enabled, recordInjection = true, scope?: string): Promise<GatheredMemory> {
	if (!enabled && !projectEnabled) return { memorySnippet: "", projectMemory: "", projectMemoryFiles: [] };
	const key = scope === undefined ? undefined : snapshotKey(scope, cwd, enabled, projectEnabled);
	const snapshot = (key === undefined ? undefined : memorySnapshots.get(key) as MemorySnapshot | undefined) ?? await readSnapshot(cwd, enabled, projectEnabled);
	if (key !== undefined) memorySnapshots.set(key, snapshot);
	const { memory, userKeys, projectKeys } = snapshot;

	// Recorded, not awaited for correctness: a failed timestamp must not cost the turn.
	if (recordInjection) await Promise.all([
		memory.memorySnippet ? markInjected(userInjectedPath(), userKeys, now).catch(() => false) : Promise.resolve(false),
		memory.projectMemory ? markInjected(projectInjectedPath(cwd), projectKeys, now).catch(() => false) : Promise.resolve(false),
	]);

	return memory;
}

async function readSnapshot(cwd: string, enabled: boolean, projectEnabled: boolean): Promise<MemorySnapshot> {

	let memorySnippet = "";
	let userKeys: string[] = [];
	try {
		const store = await loadMemory();
		memorySnippet = enabled ? formatMemoryForPrompt(store.entries) : "";
		userKeys = store.entries.map((entry) => entry.id);
	} catch {
		// Memory loading is resilient and silent.
	}

	const lessons = projectEnabled ? await readLessons(cwd).catch(() => []) : [];
	const extracted = projectEnabled ? await readExtractedMemory(cwd).catch(() => "") : "";
	const projectMemoryFiles = formatProjectMemorySources(lessons, extracted).map(part => ({
		path: join(projectMemoryDir(cwd), part.file), content: part.content,
	}));
	const projectMemory = projectMemoryFiles.map(file => file.content).join("");
	const projectKeys = [...lessons.map((lesson) => lesson.text), ...(extracted.trim() ? [EXTRACTED_KEY] : [])];
	return { memory: { memorySnippet, projectMemory, projectMemoryFiles }, userKeys, projectKeys };
}
