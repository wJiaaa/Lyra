/**
 * 一次 MCP 工具调用的结果，变成模型读得懂、放得下的样子。
 *
 * 三件事：每种内容块都有去处（文字、图片、嵌入的资源、资源链接、音频，一种都不悄悄丢）；
 * `structuredContent` 不因为服务器没附文本就消失；体积和 `bash`、`web_fetch` 一样压在循环的首发
 * 剪枝线以内，超出的全文落盘给路径。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRESH_RESULT_MAX_CHARS } from "../agent/prune.ts";
import { persistSessionImage, sessionMediaPath } from "../session/payload.ts";
import type { ImageContent, ToolResult, UserContent } from "../types.ts";

/**
 * 一条结果发给模型的文本上限，与 `bash`、`web_fetch` 相同：压在 `FRESH_RESULT_MAX_CHARS` 以内，
 * 留 2000 字符给截断说明。
 *
 * 越过那条线的结果会在模型看到之前被循环剪成前 4k、后 1k：一页 39.6k 的结果到模型那里只剩 5.3k。
 * 所以在这里就留头尾（结尾常是总数、错误、「还有 N 条」），全文写进会话的 scratch 目录，
 * 模型要中间那段自己 `read`。以前是 40,000 字符、只留开头，结尾丢了，剩下的又被剪枝再剪一次。
 */
export const MCP_RESULT_CHARS = FRESH_RESULT_MAX_CHARS - 2000;

/**
 * 多大的图片不直接塞进请求：200 KiB。
 *
 * 一张图跟着历史每轮都要重发，而大图对模型理解的增益远不如它的体积——一张 2 MB 的截图按 base64
 * 是 2.7M 字符，几次就能把一些网关的请求体上限顶穿（413）。超过的落盘，给模型一个路径，它要看就
 * `read`，那条路对图片的上限是 5 MB，和 `read` 读本地图片一样。
 */
const MCP_INLINE_IMAGE_BYTES = 200 * 1024;
/** 单张图片的绝对上限，与 `read` 相同。超过的连路径也不给模型——它读回来也会被拒。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** `tools/call` 的结果。老协议（2024-10-07 之前）只有一个 `toolResult`，没有 `content`。 */
type RawResult = { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown };

export interface ResultOptions {
	serverId: string;
	serverName: string;
	tool: string;
	/** 这个会话的 `scratch://` 目录：大图和超长结果的全文落在这里，`read` 不用再问人就能读回来。 */
	scratchDir?: string;
}

export function toToolResult(response: RawResult, options: ResultOptions): ToolResult {
	const parked: ImageContent[] = [];
	const raw = response.content ?? (response.toolResult !== undefined ? [{ type: "text", text: JSON.stringify(response.toolResult) }] : undefined);
	const content = bound(withStructured(normalize(raw, options, parked), response.structuredContent), options);
	return {
		content: content.length > 0 ? content : [{ type: "text", text: "(the server returned no content)" }],
		details: { kind: "mcp", server: options.serverName, tool: options.tool, ...(parked.length ? { images: parked } : {}) },
		isError: response.isError === true,
	};
}

function normalize(raw: unknown, options: ResultOptions, parked: ImageContent[]): UserContent[] {
	if (!Array.isArray(raw)) return [];
	const out: UserContent[] = [];
	for (const block of raw as Record<string, unknown>[]) {
		const type = block?.type;
		if (type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
		else if (type === "image" && typeof block.data === "string") out.push(...image(block.data, String(block.mimeType ?? "image/png"), options, parked));
		else if (type === "audio") out.push({ type: "text", text: `[audio (${String(block.mimeType ?? "audio")}, ${kib(block.data)}) omitted: Plume does not pass audio to the model]` });
		else if (type === "resource") out.push(...embedded(block.resource as Record<string, unknown> | undefined, options, parked));
		else if (type === "resource_link" && typeof block.uri === "string") out.push({ type: "text", text: resourceLink(block, options.serverId) });
		else out.push({ type: "text", text: `[content of type "${String(type)}" omitted: Plume does not understand it]` });
	}
	return out;
}

/** 一张图：小的原样给；大的落盘、给路径；超过 5 MB 的只说一声。 */
function image(data: string, mimeType: string, options: ResultOptions, parked: ImageContent[]): UserContent[] {
	const bytes = Math.floor((data.length * 3) / 4);
	if (bytes <= MCP_INLINE_IMAGE_BYTES) return [{ type: "image", data, mimeType }];
	if (bytes > MAX_IMAGE_BYTES) return [{ type: "text", text: `[image (${mimeType}, ${size(bytes)}) omitted: over the 5 MB limit]` }];
	// 进 `session-media` 给界面画（和会话日志挪图片是同一个按内容命名的地方），给模型的路径另存一份在 scratch：那里 `read` 不用问人。
	const media = persistSessionImage(data, mimeType);
	parked.push({ type: "image", data: "", mimeType, media });
	let path = sessionMediaPath(media);
	if (options.scratchDir) {
		try {
			const dir = join(options.scratchDir, "mcp-images");
			mkdirSync(dir, { recursive: true });
			path = join(dir, media);
			writeFileSync(path, Buffer.from(data, "base64"));
		} catch {
			path = sessionMediaPath(media);
		}
	}
	return [{ type: "text", text: `[image (${mimeType}, ${size(bytes)}) not attached inline to save context; it is shown to the user and saved at ${path} — \`read\` that path if you need to look at it]` }];
}

/** 嵌入的资源：文本带上地址给出去，图片按图片的规则，其余二进制说清楚是什么、多大。 */
function embedded(resource: Record<string, unknown> | undefined, options: ResultOptions, parked: ImageContent[]): UserContent[] {
	if (!resource) return [];
	const uri = String(resource.uri ?? "");
	const mime = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
	if (typeof resource.text === "string") return [{ type: "text", text: `[resource ${uri}${mime ? ` (${mime})` : ""}]\n${resource.text}` }];
	if (typeof resource.blob === "string") {
		if (mime?.startsWith("image/")) return image(resource.blob, mime, options, parked);
		return [{ type: "text", text: `[resource ${uri} (${mime ?? "binary"}, ${kib(resource.blob)}) is binary and not shown]` }];
	}
	return [{ type: "text", text: `[resource ${uri}]` }];
}

/**
 * 资源链接：服务器没把内容放进来，只给了地址。告诉模型去哪读——`mcp://<服务器>/<uri>` 走
 * `resources/read`，和它自己去列资源时用的是同一个地址。
 */
function resourceLink(block: Record<string, unknown>, serverId: string): string {
	const name = typeof block.title === "string" ? block.title : typeof block.name === "string" ? block.name : String(block.uri);
	const facts = [typeof block.mimeType === "string" ? block.mimeType : "", typeof block.size === "number" ? size(block.size) : ""].filter(Boolean).join(", ");
	const description = typeof block.description === "string" ? ` — ${block.description}` : "";
	return `[resource link] ${name}${facts ? ` (${facts})` : ""}${description}: ${String(block.uri)}. Read it with \`read mcp://${serverId}/${String(block.uri)}\`.`;
}

/**
 * `structuredContent` 给模型看，除非文本里已经是同一份。
 *
 * 规范说带 `outputSchema` 的工具「应当」同时把 JSON 序列化进一个文本块，这时再附一份是双份的
 * token。可「应当」不是「必须」：有的服务器只给 structuredContent、content 留空，以前模型就只拿到
 * 一句「the server returned no content」，数据在 `details` 里，而 `details` 从不发给模型。也有的
 * 文本只是一句摘要、数据全在结构里。所以按内容判断：文本里没有和它相同的那份 JSON，就附上。
 */
function withStructured(content: UserContent[], structured: unknown): UserContent[] {
	if (structured === undefined || structured === null) return content;
	const wanted = stable(structured);
	const present = content.some((block) => {
		if (block.type !== "text") return false;
		try {
			return stable(JSON.parse(block.text)) === wanted;
		} catch {
			return false;
		}
	});
	return present ? content : [...content, { type: "text", text: `structuredContent: ${JSON.stringify(structured)}` }];
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** 文本总量超过上限时，合成一段、留头尾，中间说明少了多少、全文在哪。图片原位保留。 */
function bound(blocks: UserContent[], options: ResultOptions): UserContent[] {
	const texts = blocks.filter((block): block is { type: "text"; text: string } => block.type === "text");
	const total = texts.reduce((sum, block) => sum + block.text.length, 0);
	if (total <= MCP_RESULT_CHARS) return blocks;
	const full = texts.map((block) => block.text).join("\n\n");
	const points = [...full];
	const saved = saveFull(full, options);
	const where = saved
		? `the full result is saved at ${saved} — \`read\` it with offset if you need the middle`
		: "ask the tool for less — a narrower query or a page — if you need the middle";
	const note = (omitted: number) =>
		`\n\n… [${omitted.toLocaleString("en-US")} of ${points.length.toLocaleString("en-US")} characters omitted by Plume ` +
		`(limit ${MCP_RESULT_CHARS.toLocaleString("en-US")}); ${where}.] …\n\n`;
	const keep = MCP_RESULT_CHARS - [...note(points.length)].length;
	const head = Math.floor(keep * 0.8);
	const tail = keep - head;
	const text = `${points.slice(0, head).join("")}${note(points.length - head - tail)}${points.slice(points.length - tail).join("")}`;
	return [{ type: "text", text }, ...blocks.filter((block) => block.type !== "text")];
}

/** 全文写进 scratch 的 `mcp-results/`，按内容命名；写不了（没有 scratch 目录，比如设置页探测）就不给路径。 */
function saveFull(text: string, options: ResultOptions): string | undefined {
	if (!options.scratchDir) return undefined;
	try {
		const dir = join(options.scratchDir, "mcp-results");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`);
		writeFileSync(path, text);
		return path;
	} catch {
		return undefined;
	}
}

function kib(data: unknown): string {
	return typeof data === "string" ? size(Math.floor((data.length * 3) / 4)) : "unknown size";
}

function size(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KiB`;
}
