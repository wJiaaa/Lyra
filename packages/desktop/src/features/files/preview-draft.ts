/**
 * The page a `preview` call is writing, as far as it has got — read from the call's arguments while
 * they are still streaming. See `PreviewDraft` for how it is drawn.
 */

import { partialJson } from "../../lib/partial-json.ts";

/** What the draft is made of: the document so far, and the styles kept in files of their own. */
export interface DraftDocument {
	html: string;
	/** `files` that are stylesheets: the draft has no server to fetch a `<link>` from, so they go in as they are. */
	css: string[];
}

/** Where the writing has got to: inside a stylesheet, inside a script, or in the page itself. */
export type DraftPhase = "styles" | "markup" | "script";

interface PreviewFile {
	path?: unknown;
	content?: unknown;
}

/**
 * A call's arguments as far as they are written: complete ones once the call has been parsed, the
 * raw text before that.
 */
export function draftArguments(args: Record<string, unknown>, raw: string | undefined): Record<string, unknown> {
	if (typeof args.html === "string" || Array.isArray(args.files) || !raw) return args;
	const value = partialJson(raw);
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The document in a call's arguments. `null` when the call writes no page here: an existing file
 * (`path`), a checked page published by `id`, or nothing written yet.
 */
export function draftDocument(value: Record<string, unknown>): DraftDocument | null {
	if (typeof value.html === "string") return value.html ? { html: value.html, css: [] } : null;
	if (!Array.isArray(value.files)) return null;
	const files = (value.files as PreviewFile[]).filter((file) => file && typeof file.path === "string" && typeof file.content === "string") as { path: string; content: string }[];
	const entry = typeof value.entry === "string" ? value.entry : "index.html";
	const page = files.find((file) => file.path === entry);
	if (!page?.content) return null;
	return { html: page.content, css: files.filter((file) => /\.css$/i.test(file.path)).map((file) => file.content) };
}

/** The last opening of `tag` that has no closing after it — the model is writing inside it. */
function inside(html: string, tag: string): boolean {
	const lower = html.toLowerCase();
	return lower.lastIndexOf(`<${tag}`) > lower.lastIndexOf(`</${tag}`);
}

export function draftPhase(html: string): DraftPhase {
	if (inside(html, "style")) return "styles";
	if (inside(html, "script")) return "script";
	return "markup";
}

/** Size so far, the way the progress label says it. */
export function draftSize(document: DraftDocument): string {
	const chars = document.html.length + document.css.reduce((sum, css) => sum + css.length, 0);
	return `${(chars / 1024).toFixed(1)} KB`;
}
