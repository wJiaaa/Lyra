/**
 * 能开好几个的面板，每一个在布局树里占的那一格叫什么。
 *
 * 面板在树里按 kind 认，同一种只能有一格（`tree.ts` 的不变式 2）。侧边聊天、终端和打开的文件一个
 * 会话可以开好几个，于是最早那一个仍是 `chat` / `terminal` / `file`，后开的每个是 `<种类>:<id>`：kind 本身就是它的
 * 身份，布局存盘、弹出窗口、顶上的标签都不用另外记它是哪一个。查注册表时它们都按种类认——见
 * `basePanelKind`。
 *
 * 不在面板里再套一层子标签：一个会话旁边的几个侧边聊天、几个终端、几个文件，都是顶上那排标签里的一个。
 *
 * 放在 `lib` 而不是 dock 里：面板自己也要从 kind 认出自己是哪一个，去引 dock 的大门会连成环。
 */

import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";

const MANY = ["chat", "terminal", "file"] as const;
export type ManyKind = (typeof MANY)[number];

/** 后开的那几格。 */
export type PanelInstanceKind = `${ManyKind}:${string}`;

function split(kind: string): { base: ManyKind; instance: string } | null {
	const at = kind.indexOf(":");
	if (at <= 0) return null;
	const base = kind.slice(0, at);
	const instance = kind.slice(at + 1);
	return (MANY as readonly string[]).includes(base) && instance ? { base: base as ManyKind, instance } : null;
}

/** 这种面板能不能开好几个。 */
export function allowsMany(kind: string): boolean {
	return (MANY as readonly string[]).includes(kind);
}

/** 注册表里认的那个 kind：后开的那几格按种类认，别的原样。 */
export function basePanelKind<K extends string>(kind: K): K | ManyKind {
	return split(kind)?.base ?? kind;
}

/** 后开的那一格是第几个；最早那一格和别的面板是 null。 */
export function panelInstance(kind: string): string | null {
	return split(kind)?.instance ?? null;
}

/** 这一格是哪个侧边聊天；不是侧边聊天就是 null。最早那一个用的是一个会话只有一个侧边聊天时的存档。 */
export function sideIdOfPanel(kind: string): string | null {
	if (kind === "chat") return DEFAULT_SIDE_CHAT_ID;
	const parsed = split(kind);
	return parsed?.base === "chat" ? parsed.instance : null;
}

/**
 * 再开一个该占的那一格：最早那一个没开着就是它，开着就起一个新的。
 *
 * id 时间戳在前，按字面排就是开出来的先后；只用小写字母和数字，侧边聊天的主进程拿它当文件名，
 * 见 `sidechat-store.ts`。
 */
export function nextPanelKind<K extends ManyKind>(base: K, isOpen: (kind: K) => boolean): K | `${K}:${string}` {
	if (!isOpen(base)) return base;
	return `${base}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
