/**
 * Blanking tool results that a later observation has already replaced.
 *
 * Size-pruning cuts a result because it is large. This cuts one because it is *dead*: the same
 * file was read again, the file was edited, or the same tool ran with the same arguments. The
 * later result is the current observation; the earlier one is a snapshot the model will not
 * need unless it asks (`recall`).
 *
 * oh-my-pi (`pruneSupersededToolResults`) and pi-dcp do the same two cuts, and both still go
 * through a prompt-cache gate — rewriting a warm prefix to save a few hundred characters is
 * how their #3406 happened. We reuse `worthPruning`, including the net-benefit path: a large
 * superseded read under a shorter tail is worth the one-time rewrite.
 *
 * Emptied in place, never removed. An unpaired `tool_use` poisons every later request.
 */

import type { Message, ToolResultMessage } from "../types.ts";
import { isRepeatNotice } from "../agent/repetition.ts";
import { MAX_LINE_CHARS } from "../tools/long-line.ts";
import { firstAffordableCut, PRUNE_FLOOR_CHARS, type PruneTiming } from "./prune.ts";

const PROTECTED = new Set(["skill"]);

export interface StaleCut {
	index: number;
	saving: number;
	notice: string;
}

export function staleCuts(messages: Message[]): StaleCut[] {
	const calls = callsById(messages);
	const latestReads = new Map<string, Window[]>();
	const mutated = new Set<string>();
	const seenExact = new Set<string>();
	const cuts: StaleCut[] = [];

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		if (!call || PROTECTED.has(call.name) || PROTECTED.has(message.toolName)) continue;
		/*
		 * 被循环换成「不再重复贴一遍」的那条不是一次观察，它指向的正是更早的原文。把它当成最新
		 * 的一份，更早的原文就会被判成重复或被覆盖而剪掉——两处互相指着对方，原文一份不剩。
		 */
		if (isRepeatNotice(message)) continue;

		const path = pathOf(call.arguments);
		const key = path ? intern(latestReads, mutated, path) : "";
		const fingerprint = `${call.name} ${stable(call.arguments)}`;
		const isRead = call.name === "read";
		/*
		 * What a read covers is what came back, not what was asked for: a bare read of a long
		 * source file returns an outline with every body folded, and a wide window can stop at the
		 * output budget. Judging by the arguments blanked bodies the model had read and never saw again.
		 */
		const returned = isRead && !message.isError ? returnedWindow(message.details, call.arguments) : undefined;
		const duplicate = seenExact.has(fingerprint);
		const superseded =
			!message.isError &&
			isRead &&
			key !== "" &&
			(inSet(mutated, key) || coversAny(latestReads.get(key), returned ?? askedWindow(call.arguments)));

		if (duplicate || superseded) {
			const notice = superseded ? supersededNotice(path) : duplicateNotice(call.name);
			const size = textChars(message);
			const saving = size - notice.length;
			if (size > Math.max(PRUNE_FLOOR_CHARS, notice.length) && saving > 0) cuts.push({ index, saving, notice });
		}

		// A failed or cancelled read observed nothing, so it cannot stand in for an earlier one.
		if (!(isRead && message.isError)) seenExact.add(fingerprint);
		if (key && (call.name === "write" || call.name === "edit") && !message.isError) mutated.add(key);
		if (key && returned) {
			const list = latestReads.get(key) ?? [];
			list.push(returned);
			latestReads.set(key, list);
		}
	}

	return cuts;
}

export function dropStaleResults(messages: Message[], timing: PruneTiming = {}): Message[] {
	const cuts = staleCuts(messages);
	const from = firstAffordableCut(messages, cuts, timing);
	if (from === undefined) return messages;
	return applyStaleCuts(messages, cuts.filter((cut) => cut.index >= from));
}

export function applyStaleCuts(messages: Message[], cuts: readonly StaleCut[]): Message[] {
	if (cuts.length === 0) return messages;
	const byIndex = new Map(cuts.map((cut) => [cut.index, cut.notice]));
	return messages.map((message, index) => {
		const notice = byIndex.get(index);
		if (!notice || message.role !== "toolResult") return message;
		return { ...message, content: [{ type: "text" as const, text: notice }] } as ToolResultMessage;
	});
}

function callsById(messages: Message[]): Map<string, { name: string; arguments: Record<string, unknown> }> {
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.set(part.id, { name: part.name, arguments: part.arguments ?? {} });
		}
	}
	return calls;
}

interface Window {
	from: number;
	/** `Infinity` when the window reached the last line. */
	to: number;
	charFrom: number;
	charTo: number;
}

const WHOLE: Window = { from: 1, to: Number.POSITIVE_INFINITY, charFrom: 1, charTo: Number.POSITIVE_INFINITY };

/**
 * The span a read result proves it returned verbatim, from the `details` `read` puts on it.
 *
 * Undefined whenever that cannot be proven — an outline, a truncated document, a resource, or a
 * result without details (another tool, a hand-built message). Blanking an earlier read on a
 * guess loses text the model saw; keeping it costs only characters.
 */
function returnedWindow(details: unknown, args: Record<string, unknown>): Window | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (d.kind === "image" || (d.kind === "document" && d.truncated === false)) return WHOLE;
	if (d.kind !== "text" || d.outlined === true) return undefined;
	const from = numberOf(d.shownFrom);
	const to = numberOf(d.shownTo);
	const total = numberOf(d.totalLines);
	if (from === undefined || to === undefined) return undefined;
	return { from, to: from <= 1 && total !== undefined && to >= total ? Number.POSITIVE_INFINITY : to, ...charSpan(args) };
}

/** The most an earlier read can have shown — what it asked for. Only used as the side being covered. */
function askedWindow(args: Record<string, unknown>): Window {
	const offset = numberOf(args.offset);
	const limit = numberOf(args.limit);
	const from = offset ?? 1;
	return { from, to: limit === undefined ? Number.POSITIVE_INFINITY : from + limit - 1, ...charSpan(args) };
}

// `read` applies one character window to every selected line; short lines at offset 1 fit inside it.
function charSpan(args: Record<string, unknown>): Pick<Window, "charFrom" | "charTo"> {
	const charFrom = Math.max(1, numberOf(args.char_offset) ?? numberOf(args.charOffset) ?? 1);
	return { charFrom, charTo: charFrom + MAX_LINE_CHARS - 1 };
}

function coversAny(laters: Window[] | undefined, earlier: Window): boolean {
	if (!laters) return false;
	return laters.some(
		(later) => later.from <= earlier.from && later.to >= earlier.to && later.charFrom <= earlier.charFrom && later.charTo >= earlier.charTo,
	);
}

function pathOf(args: Record<string, unknown>): string {
	for (const key of ["path", "file", "filePath", "file_path"] as const) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function pathKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string): boolean {
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function intern(reads: Map<string, Window[]>, mutated: Set<string>, path: string): string {
	const key = pathKey(path);
	if (reads.has(key) || mutated.has(key)) return key;
	for (const existing of [...reads.keys(), ...mutated]) {
		if (samePath(existing, key)) return existing;
	}
	return key;
}

function inSet(set: Set<string>, key: string): boolean {
	if (set.has(key)) return true;
	for (const existing of set) {
		if (samePath(existing, key)) return true;
	}
	return false;
}

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${k}:${stable(v)}`).join(",")}}`;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textChars(message: ToolResultMessage): number {
	return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

function supersededNotice(path: string): string {
	return `[Earlier read of \`${path}\` superseded by a later observation. The latest read, or the edit that replaced it, is below. Full text stays in the session — recall or read again if you need that snapshot.]`;
}

function duplicateNotice(tool: string): string {
	return `[Duplicate ${tool} result omitted; a later call used the same arguments. Full text stays in the session.]`;
}
