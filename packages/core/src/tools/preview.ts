import { randomUUID } from "node:crypto";
import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

interface PreviewArgs {
	title?: string;
	html?: string;
	files?: { path: string; content: string }[];
	entry?: string;
	check?: boolean;
	id?: string;
}

/** What `writePreview` hands back: everything the card and the inspector need. */
interface Page {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
	dir: string;
	themed?: boolean;
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
		"Show a self-contained web page inline in the conversation, above your reply; the user can also open it in the side panel. " +
		"Use it when the answer is something to look at or interact with — a chart, a diagram, a table to explore, a demo or game, a layout put up for approval — " +
		"not to display code for reading, where a fenced block is better. " +
		"Pass `html` for a single file, or `files` for several (the entry defaults to index.html). Inline your CSS and JS; libraries may be loaded from a CDN over https. " +
		"The page runs sandboxed, with no access to the user's machine or the app. " +
		"It sits directly in the reply, as wide as the text column (about 700px, narrower in split views): leave html and body without a background, " +
		"use no outer card, border or page title, use fluid widths, give charts fixed pixel heights, and never size anything with 100vh or height:100% — " +
		"the frame grows to fit the content, and a page taller than a screen is cut off. " +
		"The app's theme is on :root as CSS variables and follows light/dark live; use them instead of fixed colours: " +
		"--background --foreground --muted --muted-foreground --card --border --primary --primary-foreground --success --warning --danger " +
		"--code-background --code-foreground --chart-1 … --chart-6 --radius --font-sans --font-mono. " +
		"Links open in the user's browser. A page whose script throws is not shown: the error comes back so you can fix it and call again. " +
		"To see the page before the user does, pass `check: true`: it is loaded out of sight and you get back a screenshot at the conversation's width with the current theme, its console errors and its height, and the user sees nothing. " +
		"Fix and check again as needed, then publish the checked page with just its `id` — don't send the html again. " +
		"This is the way to look at a preview: don't serve it yourself or open it with the browser tools. The user already sees a published page, so don't describe it in your reply.",
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
			check: { type: "boolean", description: "Load the page out of sight and return a screenshot, console errors and height, without showing it to the user." },
			id: { type: "string", description: "Publish a page already sent with `check: true`, by the id that call returned. Pass nothing else with it." },
		},
		required: [],
		additionalProperties: false,
	},
	mutating: false,
	summarize: (args) => (args.check ? `检查网页：${args.title ?? "网页预览"}` : (args.title ?? "网页预览")),

	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		if (args.id !== undefined) {
			const draft = drafts.get(draftKey(ctx.sessionId, args.id));
			if (!draft) return errorResult(`没有找到检查过的页面 ${args.id}。带上 html 重新调用 preview。`);
			if (draft.exceptions.length > 0) return errorResult(`这个页面检查时抛出了异常，没有展示给用户：\n${list(draft.exceptions)}\n修好后带上新的 html 重新调用 preview。`);
			drafts.delete(draftKey(ctx.sessionId, args.id));
			return shown(draft.record, null);
		}

		const files = args.files?.length ? args.files : args.html ? [{ path: "index.html", content: args.html }] : [];
		if (files.length === 0) return errorResult("需要 `html` 或 `files` 其中之一。");

		const total = files.reduce((sum, file) => sum + (file.content?.length ?? 0), 0);
		if (total > MAX_TOTAL_BYTES) return errorResult("预览内容过大（超过 2MB）。");

		const entry = args.entry ?? "index.html";
		if (!files.some((file) => file.path === entry)) return errorResult(`没有找到入口文件 ${entry}。`);

		if (!ctx.writePreview) return errorResult("当前环境不支持网页预览。");

		const record: Page = await ctx.writePreview({
			id: randomUUID().slice(0, 8),
			title: args.title?.trim() || "网页预览",
			files,
			entry: args.entry,
			// Pages written against this description expect the theme variables; older ones never asked for them.
			themed: true,
		});

		/*
		 * Published straight away, the model sees no picture, but it can be told when the page is broken.
		 * (`check` is where it sees one — see `checked`.)
		 *
		 * A script error is the common way a preview fails, and from the outside it looks like nothing:
		 * a blank card, with the model already saying "here it is". The host loads the page once out of
		 * sight and reports what went wrong, so the next call can fix it. Nothing is said when nothing
		 * went wrong — a description of a page it cannot see would only be the model's guess.
		 *
		 * A page that throws is not shown at all. Shown, the reader gets the broken page and then, a
		 * call later, the fixed one under it: two cards, the first of them a mistake. A failed call
		 * stays inside the turn's folded work instead. Other console errors — a resource that did not
		 * load — leave the page standing and are only reported, since the page may well work without it.
		 */
		const inspection = inspector ? await inspector(record, { screenshot: args.check === true }).catch(() => null) : null;
		if (args.check) return checked(record, inspection, ctx.sessionId);
		if (inspection && inspection.exceptions.length > 0) {
			return errorResult(`页面加载时抛出了异常，没有展示给用户：\n${list(inspection.exceptions)}\n修好后重新调用 preview。`);
		}
		return shown(record, inspection);
	},
};

function shown(record: Page, inspection: PreviewInspection | null): ToolResult {
	return {
		content: [{ type: "text", text: [`已在对话中展示：${record.title}。用户能直接看到并操作这个页面，回复里不用再描述它。`, ...inspectionNotes(inspection)].join("\n") }],
		details: { preview: record },
	};
}

/*
 * Pages checked but not yet shown, by session and id.
 *
 * Kept here rather than looked up on disk: publishing one is the very next call in the same turn,
 * and a draft that outlives the process is one the model can simply send again. The files are on
 * disk all the same — that is where the screenshot was taken from, and where the page is served from.
 */
const drafts = new Map<string, { record: Page; exceptions: string[] }>();
const MAX_DRAFTS = 50;
const draftKey = (sessionId: string, id: string) => `${sessionId}/${id}`;

/**
 * The page as the model will never otherwise see it.
 *
 * Without this the model guesses at its own layout, and a model that wants to look finds its own
 * way: in one session it served the page with `python -m http.server`, opened it in the browser
 * and scrolled through screenshots, a dozen calls for one look. Nothing is shown to the user
 * here — that is the point of checking — so a page that throws is reported, and refused only if
 * it is then published as it is.
 */
function checked(record: Page, inspection: PreviewInspection | null, sessionId: string): ToolResult {
	const oldest = drafts.keys().next();
	if (drafts.size >= MAX_DRAFTS && !oldest.done) drafts.delete(oldest.value);
	drafts.set(draftKey(sessionId, record.id), { record, exceptions: inspection?.exceptions ?? [] });
	const lines = [`已检查，用户还看不到这个页面（id: ${record.id}）。`];
	if (!inspection) lines.push("当前环境没法加载页面，没有截图。");
	else {
		if (inspection.exceptions.length > 0) lines.push(`页面抛出了异常，这样发布会被拒绝：\n${list(inspection.exceptions)}`);
		if (inspection.errors.length > 0) lines.push(`控制台报错：\n${list(inspection.errors)}`);
		if (inspection.height !== undefined) lines.push(`内容高 ${inspection.height}px${inspection.limit !== undefined && inspection.height > inspection.limit ? `，对话里最多显示 ${inspection.limit}px，超出的部分会被截掉` : ""}。`);
		if (inspection.screenshot) lines.push(inspection.height !== undefined && inspection.limit !== undefined && inspection.height > inspection.limit ? "截图是对话里能看到的那一屏：" : "截图是用户会看到的样子：");
	}
	lines.push(`满意就用 preview({ id: "${record.id}" }) 发布；要改就带上新的 html 再检查一次。`);
	return {
		content: [{ type: "text", text: lines.join("\n") }, ...(inspection?.screenshot ? [{ type: "image" as const, ...inspection.screenshot }] : [])],
		details: { kind: "preview-check", id: record.id, title: record.title },
	};
}

/** What the host found when it loaded a preview out of sight. */
export interface PreviewInspection {
	/** Uncaught exceptions: the page's own code failed. */
	exceptions: string[];
	/** Every other console error — a resource that failed to load, a `console.error`. */
	errors: string[];
	/** The page's content height at the conversation's width, when it could be measured. */
	height?: number;
	/** The most the conversation shows before cutting a page off. */
	limit?: number;
	/** What the reader would see, when asked for: the conversation's width, up to `limit` tall. */
	screenshot?: { data: string; mimeType: string };
}

export type PreviewInspector = (
	preview: { sessionId: string; id: string; entry: string; themed?: boolean },
	options?: { screenshot?: boolean },
) => Promise<PreviewInspection | null>;

/**
 * Loading a page needs a browser, which is the host's to provide — the desktop app has one, a
 * terminal does not. Bound once at startup, the same way `useToolRegistry` is.
 */
let inspector: PreviewInspector | null = null;

export function usePreviewInspector(next: PreviewInspector | null): void {
	inspector = next;
}

/** At most this many errors go back; the first one is nearly always the cause of the rest. */
const MAX_ERRORS = 5;

function list(errors: string[]): string {
	const shown = errors.slice(0, MAX_ERRORS).map((error) => `- ${error}`);
	const more = errors.length > MAX_ERRORS ? [`- ……另有 ${errors.length - MAX_ERRORS} 条`] : [];
	return [...shown, ...more].join("\n");
}

export function inspectionNotes(inspection: PreviewInspection | null): string[] {
	if (!inspection) return [];
	const notes: string[] = [];
	if (inspection.errors.length > 0) {
		notes.push(`页面已展示，但控制台有报错：\n${list(inspection.errors)}\n如果影响页面，修好后重新调用 preview。`);
	}
	if (inspection.height !== undefined && inspection.limit !== undefined && inspection.height > inspection.limit) {
		notes.push(`页面内容高 ${inspection.height}px，对话里最多显示 ${inspection.limit}px，超出的部分会被截掉；能收紧就收紧。`);
	}
	return notes;
}
