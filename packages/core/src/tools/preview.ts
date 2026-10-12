import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { errorResult } from "./result.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { authorizeRead } from "./read-access.ts";

interface PreviewArgs {
	title?: string;
	html?: string;
	files?: { path: string; content: string }[];
	path?: string;
	entry?: string;
	check?: boolean;
	width?: number;
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
/** A phone at the narrow end, a desktop at the wide; past these a screenshot says nothing new for its cost. */
const MIN_CHECK_WIDTH = 320;
const MAX_CHECK_WIDTH = 1600;

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
	/*
	 * Kept whole on purpose. Cut down twice (to 947 tokens), the checking rules lost their weight: on
	 * "我想做一个待办清单…我选择一下" 3 of 20 runs checked the page and never published it, running to the
	 * turn limit at ~3.5× the input; this text did 12/12 (test/tool-eval/preview-eval.ts --task pick).
	 * Shorten it only with that A/B run before and after.
	 */
	description:
		"Show a self-contained web page inline in the conversation, above your reply; the user can also open it in the side panel. " +
		"Use it when the answer is something to look at or interact with — a chart, a diagram, a table to explore, a demo or game, a layout put up for approval — " +
		"not to display code for reading, where a fenced block is better. " +
		"Pass `html` for a single file, or `files` for several (the entry defaults to index.html). Inline your CSS and JS; libraries may be loaded from a CDN over https. " +
		"The user watches the page appear while you write it, before any script runs: write it in order — styles in <head>, then the markup, then scripts at the end of <body> — and write as markup (text, layout, inline SVG) whatever does not need a script to exist. " +
		"The page runs sandboxed, with no access to the user's machine or the app. " +
		"It sits directly in the reply, as wide as the text column (about 700px, narrower in split views): leave html and body without a background, " +
		"use no outer card, border or page title, use fluid widths, give charts fixed pixel heights, and never size anything with 100vh or height:100% — " +
		"the frame grows to fit the content, and a page taller than a screen is folded there until the user opens it. " +
		"The app's theme is on :root as CSS variables and follows light/dark live; use them instead of fixed colours: " +
		"--background --foreground --muted --muted-foreground --card --border --primary --primary-foreground --success --warning --danger " +
		"--code-background --code-foreground --chart-1 … --chart-6 --radius --font-sans --font-mono. " +
		"Links open in the user's browser. " +
		"A button can answer for the user: `plume.send(text)` in its click handler sends text as the user's next message to you — put what they chose in it (\"Plan B, 12 seats, yearly\"), so you can act on it without asking. " +
		"It counts only for a press, never on load, a timer or input changes, and returns false where there is no conversation (the side panel). " +
		"`plume.state` is what the page saved last time (null at first); `plume.setState(value)` saves JSON up to 16 KB. Save what the reader sets — a choice, a slider — when they set it, and start from `plume.state`, so the page opens as they left it; " +
		"what they changed reaches you as <page-state> after their next message. " +
		"When the page is a design the reader may want to fine-tune — a component, a card, a layout — offer the knobs: `plume.tweak({ label, onChange })` returns a group with " +
		"`.slider(obj, key, { label, min, max, step, unit })`, `.color(obj, key, { label })` (#rrggbb), `.toggle(obj, key, { label })` and `.select(obj, key, { label, options })`, each binding `obj[key]` (up to 12 a group). " +
		"The app draws the panel; when a control moves it sets the property and calls `onChange`, so keep `onChange` a redraw from `obj`. What the reader settles on comes back as <design-settings> for you to write into the page. " +
		"A page whose script throws is not shown: the error comes back so you can fix it and call again. " +
		"To check the page before publishing it, pass `check: true`: it is loaded out of sight and you get back a screenshot of the whole page (to 2160px) at the conversation's width with the current theme, its console errors and its height; the user sees it being written but it is not published. " +
		"Add `width` to see it at another width — 390 for a phone, 1440 for a desktop — in the same call, rather than writing variants of the page to check. " +
		"When the user is to pick one of the things the page shows, keep the picking out of the page: put it in an interface block in your reply, under the page. " +
		"Fix and check again as needed, then publish the checked page with just its `id` — don't send the html again. " +
		"To show an HTML file already on disk, pass its `path` instead of its content: a copy of that one file is shown, so call again after changing it, and keep its CSS, JS and images inline or on https. " +
		"Never start a server (python -m http.server and the like) to look at a local page. " +
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
			path: { type: "string", description: "An .html file already on disk, absolute or relative to the workspace, shown instead of `html`/`files`." },
			entry: { type: "string", description: "Which file to load. Defaults to index.html." },
			check: { type: "boolean", description: "Load the page out of sight and return a screenshot, console errors and height, without publishing it." },
			width: { type: "number", description: "With check: the width to load it at, 320–1600. Defaults to the conversation's width." },
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

		let local: string | undefined;
		let ownDraft = false;
		if (args.path !== undefined) {
			const page = await readLocalPageFor(ctx, args.path);
			if ("error" in page) return errorResult(page.error);
			local = page.content;
			ownDraft = ctx.scratchDir !== undefined && (await within(ctx.scratchDir, page.absolute));
		}
		const files = local !== undefined ? [{ path: "index.html", content: local }] : args.files?.length ? args.files : args.html ? [{ path: "index.html", content: args.html }] : [];
		if (files.length === 0) return errorResult("需要 `html`、`files` 或 `path` 其中之一。");

		const total = files.reduce((sum, file) => sum + (file.content?.length ?? 0), 0);
		if (total > MAX_TOTAL_BYTES) return errorResult("预览内容过大（超过 2MB）。");

		const entry = local !== undefined ? "index.html" : (args.entry ?? "index.html");
		if (!files.some((file) => file.path === entry)) return errorResult(`没有找到入口文件 ${entry}。`);

		if (!ctx.writePreview) return errorResult("当前环境不支持网页预览。");

		const record: Page = await ctx.writePreview({
			id: randomUUID().slice(0, 8),
			title: args.title?.trim() || (args.path ? basename(args.path) : "网页预览"),
			files,
			entry,
			// Pages written against this description expect the theme variables; older ones never asked for them,
			// and neither does a file on disk, which was written to stand as a page of its own — unless it is in
			// this conversation's scratch directory: only the agent writes there, and it wrote the page by this
			// description (no outer margin, no background). Shown as a page of its own, it sat in a framed card
			// with its content flush against the frame.
			themed: local === undefined || ownDraft,
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
		const width = args.check === true && typeof args.width === "number" && Number.isFinite(args.width) ? Math.round(Math.min(MAX_CHECK_WIDTH, Math.max(MIN_CHECK_WIDTH, args.width))) : undefined;
		const inspection = inspector ? await inspector(record, { screenshot: args.check === true, ...(width ? { width } : {}) }).catch(() => null) : null;
		if (args.check) return checked(record, inspection, ctx.sessionId);
		if (inspection && inspection.exceptions.length > 0) {
			return errorResult(`页面加载时抛出了异常，没有展示给用户：\n${list(inspection.exceptions)}\n修好后重新调用 preview。`);
		}
		return shown(record, inspection);
	},
};

/**
 * An HTML file already on disk, as the content of a preview — for `path` here and for `file://` in the browser.
 *
 * Shown as a copy rather than served from where it lies. Serving it means a server, and a server
 * stops: an agent once started `python -m http.server`, looked, killed it, and left a tab that
 * answered `ERR_CONNECTION_REFUSED` from then on. A copy under the previews directory is served by
 * the app itself for as long as the conversation exists, and a page there can reach nothing else
 * on the disk — a directory served whole would hand its scripts the project's `.env`. The cost is
 * that the copy does not follow the file, and that only this one file is copied.
 */
export async function readLocalPage(absolute: string): Promise<string> {
	if (!/\.html?$/i.test(absolute)) throw new Error(`只能打开 .html 文件：${absolute}`);
	const info = await stat(absolute).catch(() => null);
	if (!info?.isFile()) throw new Error(`没有找到文件：${absolute}`);
	if (info.size > MAX_TOTAL_BYTES) throw new Error("页面过大（超过 2MB）。");
	return readFile(absolute, "utf8");
}

/** `readLocalPage` for a tool: the path is the model's, so it is judged the way every other read is. */
export async function readLocalPageFor(ctx: ToolContext, path: string): Promise<{ content: string; absolute: string } | { error: string }> {
	const allowed = await authorizeRead(ctx, path);
	if (!allowed.ok) return { error: allowed.message };
	try {
		return { content: await readLocalPage(allowed.absolute), absolute: allowed.absolute };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Whether `absolute` is inside `root`. Compared as real paths: outside the workspace the read check hands
 * back a real path, and a scratch directory under `/var/…` is `/private/var/…` by then on macOS.
 */
async function within(root: string, absolute: string): Promise<boolean> {
	const rel = relative(await realpath(root).catch(() => root), absolute);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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
	const lines = [`已检查，还没有发布（id: ${record.id}）。`];
	if (!inspection) lines.push("当前环境没法加载页面，没有截图。");
	else {
		if (inspection.exceptions.length > 0) lines.push(`页面抛出了异常，这样发布会被拒绝：\n${list(inspection.exceptions)}`);
		if (inspection.errors.length > 0) lines.push(`控制台报错：\n${list(inspection.errors)}`);
		if (inspection.width !== undefined) lines.push(`按 ${inspection.width}px 宽检查；对话里的宽度不是这个，高度和截图都是这个宽度下的。`);
		if (inspection.height !== undefined) lines.push(`内容高 ${inspection.height}px${inspection.limit !== undefined && inspection.height > inspection.limit ? `，对话里先显示 ${inspection.limit}px，超出的部分折起来，用户点开才看得到` : ""}。`);
		if (inspection.screenshot) lines.push(inspection.shotHeight !== undefined && inspection.height !== undefined && inspection.shotHeight < inspection.height ? `截图是整页的前 ${inspection.shotHeight}px：` : "截图是整页：");
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
	/** The whole page when asked for, as far down as a screenshot goes — see `shotHeight`. */
	screenshot?: { data: string; mimeType: string };
	/** How tall the screenshot is, in CSS pixels; less than `height` when the page went on below it. */
	shotHeight?: number;
	/** The width it was checked at, when one was asked for. */
	width?: number;
}

export type PreviewInspector = (
	preview: { sessionId: string; id: string; entry: string; themed?: boolean },
	options?: { screenshot?: boolean; width?: number },
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
		notes.push(`页面内容高 ${inspection.height}px，对话里先显示 ${inspection.limit}px，超出的部分折起来，用户点开才看得到；能收紧就收紧。`);
	}
	return notes;
}
