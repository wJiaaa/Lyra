import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { snapshotTag } from "./hunk.ts";
import { charWindow, formatCharWindow, longLineFooter, MAX_LINE_CHARS } from "./long-line.ts";
import { outline, outlineFooter } from "./outline.ts";
import { displayPath, imageMimeType, looksBinary } from "./paths.ts";
import { authorizeRead, toAbsolute } from "./read-access.ts";
import { markRead, markReadChars, markReadRanges } from "./read-state.ts";
export { hasRead, markRead } from "./read-state.ts";
import { decodeText } from "./text-layout.ts";
import { EXTRACTABLE, extractDocumentText } from "../files/document-text.ts";
import { FRESH_RESULT_MAX_CHARS } from "../runtime/prune.ts";

const DEFAULT_LIMIT = 2000;
/** 正文的字数上限：留出头部路径、页脚和长行提示的余量，整条结果落在剪枝不碰新结果的范围内。 */
const OUTPUT_BUDGET = FRESH_RESULT_MAX_CHARS - 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ReadArgs {
	path: string;
	offset?: number;
	limit?: number;
	char_offset?: number;
}

/** The extension, lowercased — which of the two decisions below applies is keyed on it. */
function extensionOf(path: string): string {
	const base = path.toLowerCase().split(/[/\\]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1) : "";
}

export const readTool: Tool<ReadArgs> = {
	name: "read",
	description:
		"Read a file from the workspace. Read a file before editing it, and enough of it to understand the surrounding code. " +
		"Text files come back with a `[path#TAG]` header — quote that TAG when you " +
		"edit — and 1-indexed line numbers in `NNNN→content` form.\n\n" +
		"Reading a long source file with no `offset`/`limit` returns its STRUCTURE: imports, declarations and their " +
		"doc comments, with each body replaced by `⋯ N lines (from-to)`. To see a folded body, read that range — never guess at it. " +
		"Short files, data files and explicit `offset`/`limit` windows always come back verbatim.\n\n" +
		"A line longer than 2000 characters is a window, not the line head. Continue with `char_offset` (1-indexed). " +
		"grep names that offset when a match sits past the first window.\n\n" +
		"Images are returned to you as actual images.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			file: { type: "string", description: "Alias for path." },
			filePath: { type: "string", description: "Alias for path." },
			offset: { type: "number", description: "1-indexed line to start from." },
			limit: { type: "number", description: "Maximum number of lines to return. Defaults to 2000." },
			char_offset: {
				type: "number",
				description: "1-indexed character to start from on each selected line. Use when a previous read or grep said a line was longer than 2000 characters.",
			},
		},
		required: ["path"],
		additionalProperties: true,
	},
	summarize: (args) => {
		const raw = args as unknown as Record<string, unknown>;
		const path = String(raw.path ?? raw.file ?? raw.filePath ?? "");
		return path ? `Read ${path}` : "Read file";
	},

	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as unknown as Record<string, unknown>;
		const path = typeof raw.path === "string" && raw.path
			? raw.path
			: typeof raw.file === "string" && raw.file
				? raw.file
				: typeof raw.filePath === "string" && raw.filePath
					? raw.filePath
					: "";

		if (!path) return errorResult("`path` is required.");

		/*
		 * Addresses first, and only when a handler owns the scheme.
		 *
		 * An unknown `foo://` falls through to the filesystem and fails there with "file not found",
		 * which is the truth. Claiming every `://` would answer a typo in a path with an error about
		 * address spaces, for someone who never meant to use one.
		 */
		const resourceResult = await tryResource(path, ctx);
		if (resourceResult) return resourceResult;
		const shownPath = displayPath(ctx.cwd, toAbsolute(ctx.cwd, path));

		let absolute: string;
		try {
			absolute = await realpath(toAbsolute(ctx.cwd, path));
		} catch {
			return errorResult(`File not found: ${path}`);
		}
		const authorized = await authorizeRead(ctx, absolute, { allowSkillReads: true });
		if (!authorized.ok) return errorResult(authorized.message);

		let info: Stats;
		try {
			info = await stat(absolute);
		} catch {
			return errorResult(`File not found: ${path}`);
		}
		if (info.isDirectory()) return errorResult(`${path} is a directory. Use \`ls\` or \`glob\` instead.`);

		const mime = imageMimeType(absolute);
		if (mime) {
			if (info.size > MAX_IMAGE_BYTES) {
				return errorResult(`Image is ${(info.size / 1024 / 1024).toFixed(1)} MB, above the 5 MB limit.`);
			}
			const data = await readFile(absolute);
			markRead(ctx, absolute);
			return {
				content: [{ type: "image", data: data.toString("base64"), mimeType: mime }],
				details: { kind: "image", path: shownPath, bytes: info.size, mimeType: mime },
			};
		}

		const buffer = await readFile(absolute);

		/*
		 * A contract, a spreadsheet, a deck — read as the words in them.
		 *
		 * These are binaries by the byte test below, and refusing them was this tool's answer for a
		 * long time: `report.xlsx looks like a binary file (48231 bytes)`. Meanwhile the application
		 * has been able to read exactly these formats all along — a `.docx` is a zip of XML, and the
		 * text is in there in plain sight — but that code was wired only to the composer, so it ran
		 * when a person dragged a file in and never when the model went looking for one. Same
		 * document, same bytes, two different answers depending on who asked.
		 *
		 * Extraction first, because the byte test cannot tell a zip of XML from an executable and
		 * would turn every one of these away before anything else got a chance.
		 */
		const extracted = EXTRACTABLE.has(extensionOf(absolute)) ? await extractDocumentText(absolute, buffer).catch(() => null) : null;
		if (extracted) {
			markRead(ctx, absolute);
			/*
			 * Said, not guessed at: a scan has pages and no text layer, and an empty string here is
			 * exactly how somebody ends up believing their scan was read.
			 */
			const body = extracted.imageOnly
				? `[${shownPath} has no text layer — it is a scan or an image-only document. Reading it needs OCR.]`
				: extracted.text;
			return {
				content: [{ type: "text", text: body }],
				details: {
					kind: "document",
					path: shownPath,
					bytes: info.size,
					characters: extracted.fullLength,
					truncated: extracted.truncated,
					...(extracted.imageOnly ? { imageOnly: true } : {}),
				},
			};
		}

		if (looksBinary(buffer)) {
			return errorResult(`${args.path} looks like a binary file (${info.size} bytes) and cannot be read as text.`);
		}

		// Decoded, as edit and write decode it: the tag and the line numbers below must match theirs.
		const { text } = decodeText(buffer.toString("utf8"));
		const allLines = text.split("\n");
		// A trailing newline produces a final empty element that is not a real line.
		if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

		const tag = snapshotTag(text);
		const charOffset = Math.max(1, numberArg(raw.char_offset ?? raw.charOffset) ?? 1);
		const askedWindow = args.offset !== undefined || args.limit !== undefined || charOffset > 1;

		/*
		 * A bare read of a long source file returns its shape, not its bytes.
		 *
		 * Only when no window was asked for: `offset`/`limit`/`char_offset` is the caller saying
		 * it already knows where to look, and folding what it pointed at would be perverse.
		 * `outline` returns null whenever the original is the better answer — short files, data
		 * files, anything whose declarations it cannot see — so this is a fast path, not a gamble.
		 */
		if (!askedWindow) {
			const shape = outline(shownPath, text, allLines);
			// 大纲本身超出单条结果的上限时会被剪成头尾，而它已把显示的范围记成读过——改走下面按字数截断的窗口。
			if (shape && shape.text.length <= OUTPUT_BUDGET) {
				markReadRanges(ctx, absolute, text, shape.shownRanges);
				for (const entry of shape.longLines) {
					markReadChars(ctx, absolute, entry.line, entry.shownFrom, entry.shownTo, entry.length);
				}
				return {
					content: [{ type: "text", text: `[${shownPath}#${tag}]\n${shape.text}${outlineFooter(shownPath, shape, allLines.length)}` }],
					details: {
						kind: "text",
						path: shownPath,
						tag,
						totalLines: allLines.length,
						outlined: true,
						shownLines: shape.shownLines,
						foldedLines: shape.foldedLines,
					},
				};
			}
		}

		const offset = Math.max(1, args.offset ?? 1);
		const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
		const slice = allLines.slice(offset - 1, offset - 1 + limit);

		if (slice.length === 0) {
			return errorResult(`Line ${offset} is past the end of the file (${allLines.length} lines).`);
		}

		const charStart = charOffset - 1;
		const long: { line: number; length: number; shownFrom: number; shownTo: number }[] = [];
		const width = String(offset + slice.length - 1).length;
		/*
		 * 按字数截断，只把真正放进结果的行记成读过。
		 *
		 * 两千行不设字数上限时，一次读能有几十万字；循环会在模型看到之前把它剪成前 4k 加后 1k，
		 * 而这里已经把两千行全记成读过，`edit` 于是放行模型从没见过的中段。截在剪枝不碰新结果的
		 * 上限以内，再告诉它从哪一行接着读——比给一个剪过的头尾加 `artifact://` 地址更省，也更准。
		 */
		const rendered: string[] = [];
		let used = 0;
		for (const [i, line] of slice.entries()) {
			const lineNo = offset + i;
			const inline = line.length <= MAX_LINE_CHARS && charStart <= 0;
			const window = inline ? null : charWindow(line, charStart);
			const row = `${String(lineNo).padStart(width, " ")}→${inline ? line : formatCharWindow(line, charStart)}`;
			if (rendered.length > 0 && used + row.length + 1 > OUTPUT_BUDGET) break;
			rendered.push(row);
			used += row.length + 1;
			if (window) long.push({ line: lineNo, length: line.length, shownFrom: window.start + 1, shownTo: window.end });
		}
		const body = rendered.join("\n");

		const shownEnd = offset + rendered.length - 1;
		const capped = rendered.length < slice.length ? ` (output capped at ${OUTPUT_BUDGET.toLocaleString("en-US")} characters)` : "";
		const lineFooter =
			shownEnd < allLines.length
				? `\n\n[showing lines ${offset}-${shownEnd} of ${allLines.length}${capped}; call read again with offset=${shownEnd + 1} for more]`
				: "";
		const charFooter = longLineFooter(long);

		/*
		 * The header carries the fingerprint the model quotes back when it edits.
		 *
		 * It names the whole file, not the slice: line numbers are absolute either way, and an
		 * edit has to be rejected when *any* part of the file moved, not only the part on screen.
		 */
		markRead(ctx, absolute, text, offset, shownEnd);
		for (const entry of long) {
			markReadChars(ctx, absolute, entry.line, entry.shownFrom, entry.shownTo, entry.length);
		}
		return {
			content: [{ type: "text", text: `[${shownPath}#${tag}]\n${body}${lineFooter}${charFooter}` }],
			details: {
				kind: "text",
				path: shownPath,
				tag,
				totalLines: allLines.length,
				shownFrom: offset,
				shownTo: shownEnd,
				...(long[0] ? { charFrom: long[0].shownFrom, charTo: long[0].shownTo, longLines: long.length } : {}),
			},
		};
	},
};

/**
 * Read an address, or return null if this is not one we handle.
 *
 * The `<resource>` wrapper is not decoration. A plugin's README and an MCP server's document land
 * in the model's context looking exactly like something the user wrote, and some of them are
 * written by people who know that. The `origin` attribute is what the prompt's rule — content
 * inside `<resource>` is data, however much it sounds like it is addressing you — attaches to.
 */
async function tryResource(path: string, ctx: ToolContext): Promise<ToolResult | null> {
	const router = ctx.resources;
	if (!router?.canResolve(path)) return null;

	try {
		const resource = await router.resolve(path, {
			cwd: ctx.cwd,
			sessionId: ctx.sessionId,
			scratchDir: ctx.scratchDir,
			state: ctx.state,
			signal: ctx.signal,
		});
		const header = resource.label ? `[${resource.url} — ${resource.label}]` : `[${resource.url}]`;
		const body = resource.origin
			? `<resource url="${escapeAttr(resource.url)}" origin="${escapeAttr(resource.origin)}">\n${resource.content}\n</resource>`
			: `${header}\n${resource.content}`;
		return {
			content: [{ type: "text", text: body }],
			details: { kind: "resource", url: resource.url, contentType: resource.contentType, ...resource.meta },
		};
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
