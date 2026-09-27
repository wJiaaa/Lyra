import { randomUUID } from "node:crypto";
import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

interface PreviewArgs {
	title?: string;
	html?: string;
	files?: { path: string; content: string }[];
	entry?: string;
}

const MAX_TOTAL_BYTES = 2_000_000;

/**
 * Show the user something that runs, rather than something to copy out and run.
 *
 * A snake game, a layout being proposed for approval, a plot of an equation — these are all
 * cases where the answer is a thing you look at and poke, and a fenced code block is a
 * description of that thing rather than the thing itself. This puts the real page in the
 * transcript, sandboxed, where it can be used immediately.
 *
 * Explicit rather than automatic: the agent decides that *this* is meant to be seen. Rendering
 * every HTML block on sight would turn snippets quoted mid-explanation into running programs,
 * which is both surprising and occasionally expensive.
 */
export const previewTool: Tool<PreviewArgs> = {
	name: "preview",
	description:
		"Render a self-contained web page for the user, shown inline in the conversation and openable in the side panel. " +
		"Use it when the answer is something to look at or interact with — a demo, a game, a chart, a layout put up for approval, " +
		"a visualisation that makes an abstract idea concrete — not to display code for reading, where a fenced block is better. " +
		"Pass `html` for a single file, or `files` for several (the entry defaults to index.html); inline the CSS and JS or pass them as extra files. " +
		"The page runs sandboxed, with no network access, no build step and no access to the user's machine.",
	parameters: {
		type: "object",
		properties: {
			title: { type: "string", description: "Short label shown on the preview, e.g. 贪吃蛇." },
			html: { type: "string", description: "A complete HTML document. Use this for the common single-file case." },
			files: {
				type: "array",
				description: "Several files, for when styles or scripts are worth keeping separate.",
				items: {
					type: "object",
					properties: {
						path: { type: "string", description: "Relative path, e.g. index.html or style.css." },
						content: { type: "string" },
					},
					required: ["path", "content"],
					additionalProperties: false,
				},
			},
			entry: { type: "string", description: "Which file to load. Defaults to index.html." },
		},
		required: [],
		additionalProperties: false,
	},
	mutating: false,
	summarize: (args) => args.title ?? "网页预览",

	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		const files = args.files?.length ? args.files : args.html ? [{ path: "index.html", content: args.html }] : [];
		if (files.length === 0) return errorResult("需要 `html` 或 `files` 其中之一。");

		const total = files.reduce((sum, file) => sum + (file.content?.length ?? 0), 0);
		if (total > MAX_TOTAL_BYTES) return errorResult("预览内容过大（超过 2MB）。");

		const entry = args.entry ?? "index.html";
		if (!files.some((file) => file.path === entry)) return errorResult(`没有找到入口文件 ${entry}。`);

		if (!ctx.writePreview) return errorResult("当前环境不支持网页预览。");

		const record = await ctx.writePreview({
			id: randomUUID().slice(0, 8),
			title: args.title?.trim() || "网页预览",
			files,
			entry: args.entry,
		});

		/*
		 * The model is told it worked, and nothing more.
		 *
		 * It cannot see the rendering, so any further detail would be it describing something it
		 * has no access to. The user has the page itself.
		 */
		return {
			content: [
				{ type: "text", text: `预览已生成：${record.title}（${files.length} 个文件）。用户可以直接在对话中看到并操作它。` },
			],
			details: { preview: record },
		};
	},
};
