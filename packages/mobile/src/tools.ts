import type { Message } from "@plume/client-runtime";
import type { Key, T } from "./i18n.ts";
import type { IconName } from "./ui.tsx";

/**
 * 一次工具调用用人话怎么说：动词、图标、主语。
 *
 * 动词和桌面 `lib/tool-kinds.ts` 的 KIND 表同一套说法——同一份会话在两端读到的应当是同一句
 * 「读取文件 3 个」。表里没有的（MCP 工具、插件工具）直接用工具名，不落到一句「使用工具」：
 * 那一行读作「使用工具 3 个」，而那三个各是各的事。
 */
const KINDS: Record<string, { verb: Key; icon: IconName }> = {
	read: { verb: "toolRead", icon: "file-text" },
	write: { verb: "toolCreate", icon: "file-plus" },
	edit: { verb: "toolEdit", icon: "edit-3" },
	bash: { verb: "toolBash", icon: "terminal" },
	bash_output: { verb: "toolOutput", icon: "terminal" },
	glob: { verb: "toolFind", icon: "folder" },
	grep: { verb: "toolGrep", icon: "search" },
	ls: { verb: "toolLs", icon: "list" },
	todo_write: { verb: "toolTodo", icon: "check-square" },
	web_fetch: { verb: "toolFetch", icon: "globe" },
	web_search: { verb: "toolWebSearch", icon: "globe" },
	task: { verb: "toolDelegate", icon: "users" },
	preview: { verb: "toolPreview", icon: "eye" },
	symbol: { verb: "toolSymbol", icon: "hash" },
	lsp: { verb: "toolSymbol", icon: "hash" },
	skill: { verb: "toolSkill", icon: "zap" },
	learn: { verb: "toolLearn", icon: "book-open" },
	recall: { verb: "toolRecall", icon: "clock" },
	ask_user: { verb: "toolAsk", icon: "message-circle" },
	read_main_chat: { verb: "toolReadMain", icon: "message-square" },
};

export function toolIcon(name: string): IconName { return KINDS[name]?.icon ?? "tool"; }
export function toolVerb(name: string, t: T): string { const kind = KINDS[name]; return kind ? t(kind.verb) : name; }

function field(args: unknown, ...keys: string[]): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
	return "";
}
const oneLine = (text: string, max = 120) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const PATH_KEYS = ["path", "file_path", "filePath"];

function basename(path: string): string { return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path; }

/** 文件类工具的完整路径，用来在详情里补全「是哪个 a.ts」。 */
export function toolPath(name: string, args: unknown): string {
	return ["read", "write", "edit"].includes(name) ? field(args, ...PATH_KEYS) : "";
}

/**
 * 一行里跟在动词后面的那个东西：文件名、命令、搜索词。
 *
 * 文件只给文件名——手机一行放不下 `packages/desktop/src/features/…`，而认一个文件靠的是名字；
 * 完整路径在详情里。别的工具挑人一眼能认出这一步在干嘛的参数，认不出来就挑第一个字符串。
 */
export function toolSubject(name: string, args: unknown): string {
	const path = toolPath(name, args);
	if (path) return basename(path);
	const known = name === "bash" ? field(args, "command", "cmd")
		: name === "grep" || name === "glob" ? field(args, "pattern")
		: name === "web_fetch" ? field(args, "url").replace(/^https?:\/\//, "")
		: name === "web_search" ? field(args, "query")
		: name === "task" ? field(args, "description", "prompt")
		: name === "ask_user" ? field(args, "question")
		: name === "todo_write" ? "—"
		: "";
	if (known) return known === "—" ? "" : oneLine(known);
	const value = field(args, ...PATH_KEYS, "command", "pattern", "query", "url", "description", "name")
		|| (args && typeof args === "object" ? Object.values(args).find((entry): entry is string => typeof entry === "string" && entry.length > 0) ?? "" : "");
	return oneLine(value);
}

/** 编辑、写文件的结果里带着行数；没有就是 null，不显示「+0 −0」。 */
export function diffStat(details: unknown): { added: number; removed: number } | null {
	if (!details || typeof details !== "object") return null;
	const { added, removed } = details as { added?: unknown; removed?: unknown };
	return typeof added === "number" && typeof removed === "number" ? { added, removed } : null;
}

export function sumStats(list: unknown[]): { added: number; removed: number } | null {
	const stats = list.map(diffStat).filter((stat) => stat !== null);
	return stats.length ? { added: stats.reduce((sum, stat) => sum + stat.added, 0), removed: stats.reduce((sum, stat) => sum + stat.removed, 0) } : null;
}

/**
 * 一串调用合成一句：按动词分组，一种动作只有一次就说出它的主语，多了就数。
 * 「读取文件 a.ts、执行命令 3 个」——和桌面 `describeRun` 同一个规则。
 */
export function describeCalls(calls: { name: string; args: unknown }[], t: T): string {
	const groups = new Map<string, string[]>();
	for (const call of calls) {
		const verb = toolVerb(call.name, t);
		groups.set(verb, [...groups.get(verb) ?? [], toolSubject(call.name, call.args)]);
	}
	return [...groups].map(([verb, subjects]) => subjects.length > 1 ? t("countOf", { kind: verb, n: subjects.length })
		: subjects[0] ? `${verb} ${subjects[0]}` : verb).join(t("listSep"));
}

export interface Todo { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }

/** 最近一次清单工具的结果就是当前计划；还没有过就是 null。 */
export function latestTodos(messages: Message[]): Todo[] | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult") continue;
		const details = message.details as { kind?: unknown; todos?: unknown } | undefined;
		if (details?.kind === "todo" && Array.isArray(details.todos)) return details.todos as Todo[];
	}
	return null;
}
