/**
 * 服务器上的东西给模型、给 `/` 菜单看时叫什么。
 *
 * 工具和 prompt 共用这一条规则，单独放一个文件是因为两边都要它：`client.ts` 起连接、`prompts.ts`
 * 列 prompt，而后者被前者引用——规则放在任何一边都会绕成一个环。
 */

import { createHash } from "node:crypto";

/**
 * 各家函数名的共同约束。Plume 发请求的三条协议里，Anthropic Messages 与 OpenAI 的 Chat Completions、
 * Responses 都要求 `^[a-zA-Z0-9_-]{1,64}$`；经兼容接口转到 Gemini 时再多一条「以字母或下划线开头」，
 * `mcp__` 前缀天然满足。取交集，一个名字在哪条协议上都能发。
 */
const MAX_TOOL_NAME = 64;

/**
 * 给模型看的名字。放得下、又没有被清洗改过字的，就是原来的 `mcp__<服务器>__<工具>`；超过 64 个
 * 字符、名字里有要换掉的字符（`.`、空格、中文），或者撞上 `taken` 里的名字，就截短并接上由
 * 服务器 id 和原名算出的哈希。
 *
 * 清洗改过字就加哈希，而不是等撞了再加：`a.b` 和 `a_b` 清洗后相同，「谁先列出来谁拿原名」会让
 * 服务器换个顺序、或者 list_changed 新加一个工具，就把另一个工具的名字换掉——「总是允许」和历史
 * 里的调用都记在名字上。这样同一个工具每次得到同一个名字，只取决于它自己。
 *
 * 执行时用的是闭包里的原名，不从这个名字反解，所以截短不影响调用。
 */
export function qualifiedToolName(serverId: string, toolName: string, taken: ReadonlySet<string> = new Set()): string {
	const tool = sanitize(toolName);
	const plain = `mcp__${sanitize(serverId)}__${tool}`;
	if (tool === toolName && plain.length <= MAX_TOOL_NAME && !taken.has(plain)) return plain;
	return hashed(plain, serverId, toolName);
}

function hashed(plain: string, serverId: string, toolName: string): string {
	const hash = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 8);
	return `${plain.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

/**
 * 跨服务器去重：两台服务器的工具得到同一个名字，或者撞上宿主已有的工具名时，每一个撞名的都换成
 * 带哈希的那个。
 *
 * 撞名只在服务器 id 清洗后相同（`a.b` 与 `a_b`）或拆分有歧义（服务器 `a__b` 的 `c` 与服务器 `a`
 * 的 `b__c`）时出现。两边都换、而不是先到的留着：留谁取决于谁先连上，下一次启动可能就反过来。
 * 哈希里带着服务器 id，换出来的两个名字必然不同。
 *
 * `entries` 里每一项的 `name` 是 `qualifiedToolName` 的结果；返回同样顺序的最终名字。
 */
export function dedupeToolNames(entries: readonly { serverId: string; toolName: string; name: string }[], reserved: ReadonlySet<string> = new Set()): string[] {
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
	return entries.map((entry) =>
		(counts.get(entry.name) ?? 0) > 1 || reserved.has(entry.name)
			? hashed(`mcp__${sanitize(entry.serverId)}__${sanitize(entry.toolName)}`, entry.serverId, entry.toolName)
			: entry.name,
	);
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
