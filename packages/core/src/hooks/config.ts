/**
 * 钩子配置：用户级在 `settings.json` 的 `hooks`，项目级在 `<cwd>/.lyra/config.json` 的 `hooks`。
 *
 * 形状照 Claude Code 插件 `hooks.json` 那一套：按事件分组，每组一个 matcher，
 * 组里是若干条命令。设置页按「一条钩子一行」来增删改，所以这里同时负责两种视图之间的换算——
 * 盘上是分组的，界面上是摊平的，`id` 就是摊平时的位置。
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { projectConfigPath, readConfigFile } from "../config/layers.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";

export const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];
export type HookScope = "user" | "project";

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 32_768;

interface HookDefinitionBase {
	command: string;
	enabled?: boolean;
	statusMessage?: string;
	timeoutMs?: number;
	/** 认不出的键原样保留：设置页的「自定义字段 JSON」写的就是它们。 */
	[key: string]: unknown;
}

interface HookCommandDefinition extends HookDefinitionBase {
	type: "command";
	async?: boolean;
	shell?: true | string;
	/** 秒。和 `timeoutMs` 同时给出时以 `timeoutMs` 为准。 */
	timeout?: number;
}

interface HookProcessDefinition extends HookDefinitionBase {
	type: "process";
	args?: string[];
}

export type HookDefinition = HookCommandDefinition | HookProcessDefinition;

interface HookMatcherGroup {
	matcher?: string;
	hooks: HookDefinition[];
}

export interface HooksConfig {
	timeoutMs?: number;
	maxOutputBytes?: number;
	events: Partial<Record<HookEventName, HookMatcherGroup[]>>;
}

/** 摊平之后的一条。`id` 是位置，任何一次改动之后都要重新读。 */
export interface HookEntry {
	id: string;
	scope: HookScope;
	event: HookEventName;
	matcher?: string;
	definition: HookDefinition;
	/** 项目钩子的信任凭据：命令内容一变它就变，旧的信任随之失效。 */
	digest: string;
}

/** 设置页交回来的一条钩子。 */
export interface HookDraft {
	event: HookEventName;
	matcher?: string;
	type: "command" | "process";
	command: string;
	args?: string[];
	async?: boolean;
	shell?: true | string;
	statusMessage?: string;
	/** 秒。 */
	timeout?: number;
	enabled?: boolean;
	custom?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set(["type", "command", "args", "async", "shell", "statusMessage", "timeout", "timeoutMs", "enabled"]);

export const EMPTY_HOOKS_CONFIG: HooksConfig = { events: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDefinition(raw: unknown): HookDefinition | null {
	if (!isRecord(raw)) return null;
	if (raw.type !== "command" && raw.type !== "process") return null;
	if (typeof raw.command !== "string" || !raw.command.trim()) return null;
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) if (!KNOWN_KEYS.has(key)) extra[key] = value;
	const common = {
		...extra,
		command: raw.command,
		...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
		...(typeof raw.statusMessage === "string" && raw.statusMessage ? { statusMessage: raw.statusMessage } : {}),
		...(positive(raw.timeoutMs) ? { timeoutMs: positive(raw.timeoutMs) } : {}),
	};
	if (raw.type === "process") {
		const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined;
		return { ...common, type: "process", ...(args ? { args } : {}) };
	}
	return {
		...common,
		type: "command",
		...(typeof raw.async === "boolean" ? { async: raw.async } : {}),
		...(raw.shell === true || (typeof raw.shell === "string" && raw.shell) ? { shell: raw.shell as true | string } : {}),
		...(positive(raw.timeout) ? { timeout: positive(raw.timeout) } : {}),
	};
}

/** 读进来的任何东西都过一遍这里：认不出的事件、缺命令的条目丢掉，而不是让一处写错拖垮整份配置。 */
export function normalizeHooksConfig(raw: unknown): HooksConfig {
	if (!isRecord(raw)) return { events: {} };
	const events: HooksConfig["events"] = {};
	const rawEvents = isRecord(raw.events) ? raw.events : {};
	for (const event of HOOK_EVENTS) {
		const groups = rawEvents[event];
		if (!Array.isArray(groups)) continue;
		const normalized: HookMatcherGroup[] = [];
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
			const hooks = group.hooks.map(normalizeDefinition).filter((hook): hook is HookDefinition => hook !== null);
			if (hooks.length === 0) continue;
			const matcher = typeof group.matcher === "string" && group.matcher.trim() ? group.matcher.trim() : undefined;
			normalized.push({ ...(matcher ? { matcher } : {}), hooks });
		}
		if (normalized.length > 0) events[event] = normalized;
	}
	return {
		...(positive(raw.timeoutMs) ? { timeoutMs: positive(raw.timeoutMs) } : {}),
		...(positive(raw.maxOutputBytes) ? { maxOutputBytes: positive(raw.maxOutputBytes) } : {}),
		events,
	};
}

/** 超时，毫秒：`timeoutMs` 优先，其次 command 的 `timeout`（秒），都没有就用整份配置的默认值。 */
export function hookTimeoutMs(definition: HookDefinition, fallbackMs: number): number {
	const ms = definition.timeoutMs ?? (definition.type === "command" && definition.timeout !== undefined ? definition.timeout * 1000 : fallbackMs);
	return Math.max(1, Math.round(ms));
}

/**
 * 一条钩子的指纹。`enabled` 不在里面：开关一条已经信任过的钩子不该要求再审一遍，改命令才该。
 */
function hookDigest(event: HookEventName, matcher: string | undefined, definition: HookDefinition): string {
	const { enabled: _enabled, ...rest } = definition;
	const canonical = JSON.stringify({ event, matcher: matcher ?? "", definition: sortKeys(rest) });
	return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

export function hookEntries(config: HooksConfig, scope: HookScope): HookEntry[] {
	const entries: HookEntry[] = [];
	for (const event of HOOK_EVENTS) {
		for (const [groupIndex, group] of (config.events[event] ?? []).entries()) {
			for (const [hookIndex, definition] of group.hooks.entries()) {
				entries.push({
					id: `${scope}:${event}:${groupIndex}:${hookIndex}`,
					scope,
					event,
					...(group.matcher ? { matcher: group.matcher } : {}),
					definition,
					digest: hookDigest(event, group.matcher, definition),
				});
			}
		}
	}
	return entries;
}

function locate(config: HooksConfig, id: string): { event: HookEventName; group: number; hook: number } | null {
	const [, event, group, hook] = id.split(":");
	if (!(HOOK_EVENTS as readonly string[]).includes(event)) return null;
	const at = { event: event as HookEventName, group: Number(group), hook: Number(hook) };
	return config.events[at.event]?.[at.group]?.hooks[at.hook] ? at : null;
}

function definitionFromDraft(draft: HookDraft): HookDefinition {
	const common = {
		...draft.custom,
		command: draft.command.trim(),
		...(draft.enabled === false ? { enabled: false } : {}),
		...(draft.statusMessage?.trim() ? { statusMessage: draft.statusMessage.trim() } : {}),
	};
	if (draft.type === "process") {
		return { ...common, type: "process", ...(draft.args?.length ? { args: draft.args } : {}), ...(positive(draft.timeout) ? { timeoutMs: Math.round(draft.timeout! * 1000) } : {}) };
	}
	return {
		...common,
		type: "command",
		...(draft.async ? { async: true } : {}),
		...(draft.shell ? { shell: draft.shell } : {}),
		...(positive(draft.timeout) ? { timeout: draft.timeout } : {}),
	};
}

function clone(config: HooksConfig): HooksConfig {
	return structuredClone(config);
}

/** 追加到同一事件下 matcher 相同的第一组里，没有就新开一组。 */
export function addHook(config: HooksConfig, draft: HookDraft): HooksConfig {
	const next = clone(config);
	const matcher = draft.matcher?.trim() || undefined;
	const groups = (next.events[draft.event] ??= []);
	const group = groups.find((candidate) => (candidate.matcher ?? undefined) === matcher);
	const definition = definitionFromDraft(draft);
	if (group) group.hooks.push(definition);
	else groups.push({ ...(matcher ? { matcher } : {}), hooks: [definition] });
	return next;
}

export function removeHook(config: HooksConfig, id: string): HooksConfig {
	const at = locate(config, id);
	if (!at) return config;
	const next = clone(config);
	const groups = next.events[at.event]!;
	groups[at.group].hooks.splice(at.hook, 1);
	if (groups[at.group].hooks.length === 0) groups.splice(at.group, 1);
	if (groups.length === 0) delete next.events[at.event];
	return next;
}

/** 事件和 matcher 都没变就原地替换，位置不动；变了就挪到新的那一组。 */
export function updateHook(config: HooksConfig, id: string, draft: HookDraft): HooksConfig {
	const at = locate(config, id);
	if (!at) return addHook(config, draft);
	const matcher = draft.matcher?.trim() || undefined;
	if (at.event === draft.event && config.events[at.event]![at.group].matcher === matcher) {
		const next = clone(config);
		next.events[at.event]![at.group].hooks[at.hook] = definitionFromDraft(draft);
		return next;
	}
	return addHook(removeHook(config, id), draft);
}

export function setHookEnabled(config: HooksConfig, id: string, enabled: boolean): HooksConfig {
	const at = locate(config, id);
	if (!at) return config;
	const next = clone(config);
	const hooks = next.events[at.event]![at.group].hooks;
	const { enabled: _previous, ...rest } = hooks[at.hook];
	hooks[at.hook] = (enabled ? rest : { ...rest, enabled: false }) as HookDefinition;
	return next;
}

function isEmptyHooksConfig(config: HooksConfig): boolean {
	return Object.keys(config.events).length === 0 && config.timeoutMs === undefined && config.maxOutputBytes === undefined;
}

/** 项目钩子。文件坏了照样返回空配置，错误交给调用方去说。 */
export async function readProjectHooks(cwd: string): Promise<{ config: HooksConfig; path: string; error?: string }> {
	const path = projectConfigPath(cwd);
	const { config, error } = await readConfigFile(path);
	return { config: normalizeHooksConfig(config.hooks), path, ...(error ? { error } : {}) };
}

/**
 * 写回项目文件，只动 `hooks` 这一个键——这份文件还装着别的项目设置，而且是进版本库的。
 *
 * 文件读不出来时拒绝写：覆盖一份写坏了的配置等于把别人没写完的东西连同错误一起删掉。
 */
export async function writeProjectHooks(cwd: string, hooks: HooksConfig): Promise<void> {
	const path = projectConfigPath(cwd);
	const { config, error } = await readConfigFile(path);
	if (error) throw new Error(error);
	const next = { ...config };
	if (isEmptyHooksConfig(hooks)) delete next.hooks;
	else next.hooks = hooks;
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}
