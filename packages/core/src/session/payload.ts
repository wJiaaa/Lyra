/**
 * How large inline payloads leave the session log.
 *
 * The log used to stringify the whole user message, pixels included. One WeChat
 * dump became a 20 MB jsonl line; opening that conversation for display had to
 * read and `JSON.parse` it even though the window only needed the text. Display
 * reads strip those fields from the raw line first. New writes park the bytes
 * next to the log and keep a pointer.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, UserContent } from "../types.ts";

/** Inline icons stay in the record. Anything bigger is a file. */
export const INLINE_IMAGE_CHARS = 8_000;

export function sessionMediaHome(): string {
	return join(process.env.PLUME_HOME || join(homedir(), ".plume"), "session-media");
}

export function sessionMediaPath(name: string): string {
	return join(sessionMediaHome(), name);
}

/**
 * Drop oversized `"data":"…"` values from a jsonl line without allocating them.
 *
 * For display reads. A message's images were parked in `session-media` when it was written, so what
 * is left inline here is a tool's image nested in an event, which the transcript never draws.
 */
export function slimJsonlLine(line: string, keep = INLINE_IMAGE_CHARS): string {
	if (line.length <= keep + 16) return line;
	const needle = '"data":"';
	const parts: string[] = [];
	let last = 0;
	let from = 0;
	let changed = false;
	while (true) {
		const start = line.indexOf(needle, from);
		if (start < 0) break;
		const valueStart = start + needle.length;
		const valueEnd = line.indexOf('"', valueStart);
		if (valueEnd < 0) break;
		if (valueEnd - valueStart > keep) {
			parts.push(line.slice(last, valueStart));
			last = valueEnd;
			changed = true;
		}
		from = valueEnd + 1;
	}
	if (!changed) return line;
	parts.push(line.slice(last));
	return parts.join("");
}

export function parkRecordPayload<T>(payload: T): T {
	const record = payload as { type?: string; message?: Message };
	if (record.type !== "message" || !record.message) return payload;
	const message = parkMessage(record.message);
	if (message === record.message) return payload;
	return { ...payload, message };
}

export function parkMessage(message: Message): Message {
	if (message.role !== "user" && message.role !== "toolResult") return message;
	const content = parkUserContent(message.content);
	if (content === message.content) return message;
	return { ...message, content };
}

export async function rehydrateMessages(messages: Message[]): Promise<Message[]> {
	let changed = false;
	const next = await Promise.all(
		messages.map(async (message) => {
			if (message.role !== "user" && message.role !== "toolResult") return message;
			const content = await Promise.all(message.content.map(rehydratePart));
			if (content.every((part, i) => part === message.content[i])) return message;
			changed = true;
			return { ...message, content };
		}),
	);
	return changed ? next : messages;
}

function parkUserContent(content: UserContent[]): UserContent[] {
	let changed = false;
	const next = content.map((part) => {
		if (part.type !== "image" || part.media || part.data.length <= INLINE_IMAGE_CHARS) return part;
		changed = true;
		return { ...part, data: "", media: persistSessionImage(part.data, part.mimeType) };
	});
	return changed ? next : content;
}

async function rehydratePart(part: UserContent): Promise<UserContent> {
	if (part.type !== "image" || part.data || !part.media) return part;
	const data = await readSessionImage(part.media);
	return data === null ? part : { ...part, data };
}

export function persistSessionImage(data: string, mimeType: string): string {
	const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
	const bytes = Buffer.from(data, "base64");
	const digest = createHash("sha1").update(bytes).digest("hex");
	const name = `${digest}.${ext}`;
	const dir = sessionMediaHome();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	if (!existsSync(path)) writeFileSync(path, bytes);
	return name;
}

async function readSessionImage(name: string): Promise<string | null> {
	const safe = safeMediaName(name);
	if (!safe) return null;
	const bytes = await readFile(sessionMediaPath(safe)).catch(() => null);
	return bytes ? bytes.toString("base64") : null;
}

/**
 * Records that may point at a parked file, as an SQL condition on `body`.
 *
 * A filter, not a parse: every parked name ends `.png"`, `.jpg"` or `.webp"` inside the JSON, and
 * SQLite can rule out the rest without handing the body to JS. `mediaNamesIn` does the reading.
 */
export const MAY_HOLD_MEDIA = `(instr(body, '.png"') > 0 OR instr(body, '.jpg"') > 0 OR instr(body, '.webp"') > 0)`;

/**
 * Every parked file named in a record, under whatever key — a message's `media`, a browser tool's
 * `thumbnail`. A name is the content's SHA-1, so a stray match is no real risk.
 */
export function mediaNamesIn(body: string): string[] {
	return body.match(/[a-f0-9]{40}\.(?:png|jpg|webp)/g) ?? [];
}

export function safeMediaName(name: string): string {
	const base = name.replace(/^.*[/\\]/, "");
	if (!/^[a-f0-9]{40}\.(png|jpg|webp)$/.test(base)) return "";
	return base;
}
