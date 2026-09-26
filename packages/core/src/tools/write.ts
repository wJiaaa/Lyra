import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolResult } from "../types.ts";
import { withTextFile } from "./file-write.ts";
import { computeDiff, formatDiff } from "./diff.ts";
import { displayPath, resolveWorkspacePath } from "./paths.ts";
import { markRead, readRecord, readVersion } from "./read-state.ts";
import { decodeInput, decodeText, encodeText } from "./text-layout.ts";

interface WriteArgs {
	path: string;
	content: string;
}

export const writeTool: Tool<WriteArgs> = {
	name: "write",
	snippet: "Create or overwrite whole files",
	guidelines: [
		"Prefer edit over write for changes to an existing file; write replaces the entire contents.",
		"Never create documentation, README or example files unless the user asked for them.",
	],
	description:
		"Write a file, creating parent directories as needed. Overwrites the whole file. " +
		"To modify part of an existing file, prefer `edit` — it is safer and cheaper. " +
		"You must `read` an existing file before overwriting it.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			content: { type: "string", description: "Complete file contents." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	mutating: true,
	executionMode: "sequential",
	summarize: (args) => `Write ${args.path}`,

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.content !== "string") return errorResult("`content` must be a string.");

		/*
		 * Writable addresses, of which there is exactly one.
		 *
		 * The refusal for everything else is the point rather than a gap. A model that could
		 * `write rule://no-force-push` could rewrite the constraint that stops it force-pushing,
		 * and the rewrite would look like any other tool call. Changing a rule goes through the
		 * filesystem, where the user's own review of a diff applies.
		 */
		if (ctx.resources?.canResolve(args.path)) {
			try {
				await ctx.resources.write(args.path, args.content, {
					cwd: ctx.cwd,
					sessionId: ctx.sessionId,
					scratchDir: ctx.scratchDir,
					state: ctx.state,
					signal: ctx.signal,
				});
				return {
					content: [{ type: "text", text: `Wrote ${args.path} (${args.content.length} characters).` }],
					details: { kind: "resource", url: args.path },
				};
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		}

		/*
		 * 不吃 `ctx.allowedPaths`——那是「给你看一眼」，不是「可以改」。
		 *
		 * 那份集合来自用户拖进输入框的附件（`runtime/session-turn.ts` 的 `collectAllowedPaths`），
		 * 而拖一个文件进来的意思是让模型读它。把同一份许可接到写这一侧，等于一次「你看看我的
		 * ~/.zshrc」就永久换来了对它的写权限——在完全访问模式下没有任何一步会再问。
		 *
		 * 读那一侧留着（`read.ts`、`ls.ts`），那是附件本来的用途。
		 */
		try {
			return await withTextFile(ctx, args.path, async ({ path: absolute, before, write }) => {
				const alreadyExists = before !== null;
				const previous = alreadyExists ? decodeText(before) : null;
				if (previous && readRecord(ctx, absolute)?.version !== readVersion(previous.text)) {
					return errorResult(`Read the current text of ${args.path} before overwriting it.`);
				}
				const content = previous ? decodeInput(args.content.replace(/^\uFEFF/, ""), previous.layout) : args.content;
				const written = previous ? encodeText(content, previous.layout) : content;
				const after = decodeText(written).text;
				const diff = computeDiff(previous?.text ?? "", after);
				const shown = displayPath(ctx.cwd, resolveWorkspacePath(ctx.cwd, args.path));

				if (ctx.requestApproval) {
					const decision = await ctx.requestApproval({
						kind: "write",
						title: alreadyExists ? `Overwrite ${shown}` : `Create ${shown}`,
						detail: formatDiff(diff, shown),
						subject: absolute,
					});
					if (decision !== "once" && decision !== "always") return errorResult("The user rejected this write.");
				}

				const changeId = await write(written);
				const lines = after === "" ? 0 : after.split("\n").length;
				if (lines > 0) markRead(ctx, absolute, after, 1, lines);
				else markRead(ctx, absolute, after);

				return {
					content: [
						{
							type: "text",
							text: `${alreadyExists ? "Updated" : "Created"} ${shown} (${lines} lines).`,
						},
					],
					details: {
						kind: "write",
						changeId,
						path: shown,
						created: !alreadyExists,
						added: diff.added,
						removed: diff.removed,
						hunks: diff.hunks,
					},
				};
			});
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};
