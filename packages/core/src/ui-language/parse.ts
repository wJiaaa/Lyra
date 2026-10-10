/**
 * The markup of an interface block, read while it is still being written.
 *
 * A reply streams in a few characters at a time, and the block is drawn the whole way — so most of
 * the inputs this sees stop somewhere in the middle: inside a tag, inside an attribute, inside an
 * expression. The rule for all of them is the same: **draw what is finished, hold back what is not.**
 *
 * - A tag is drawn once its `>` is in. Half a tag is all of its attributes or none of them: a chart
 *   with half its data array would draw a different chart, then redraw as the rest arrived.
 * - An element whose closing tag has not come yet is open, and its children so far are drawn.
 * - Text is drawn as it comes; an `{expression}` in it waits for its `}`.
 *
 * What this cannot draw it reports (`problems`) rather than throws: a reply with one broken tag
 * still shows the rest, and the problems go back to the model on its next turn (`notes.ts`).
 */

import { parseExpression, type Expression } from "./expression.ts";

export type PropValue =
	| { kind: "text"; text: string }
	| { kind: "expression"; source: string; expression: Expression | null; error?: string }
	/** A bare attribute, `<Toggle checked/>`: true, as in JSX. */
	| { kind: "flag" };

export interface UiElement {
	kind: "element";
	name: string;
	props: Record<string, PropValue>;
	children: UiNode[];
	/** Its closing tag has not been written yet. */
	open: boolean;
}

export type TextPart = string | { source: string; expression: Expression | null; error?: string };

export interface UiText {
	kind: "text";
	parts: TextPart[];
}

export type UiNode = UiElement | UiText;

export interface ParsedBlock {
	nodes: UiNode[];
	/** What could not be read, in the words the model will be shown. */
	problems: string[];
}

/** The index just past the `}` that closes the `{` at `start`, or -1 if it has not been written yet. */
function closingBrace(source: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let at = start; at < source.length; at++) {
		const char = source[at]!;
		if (quote) {
			if (char === "\\") at++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return at + 1;
	}
	return -1;
}

function expressionOf(source: string): { source: string; expression: Expression | null; error?: string } {
	const parsed = parseExpression(source);
	return parsed.ok ? { source, expression: parsed.expression } : { source, expression: null, error: parsed.error };
}

/**
 * Text between tags, the way JSX reads it: lines trimmed, line breaks inside a run of text become a
 * single space, and a run that is only whitespace and a line break is layout, not text.
 */
function textParts(raw: string, problems: string[]): TextPart[] {
	const parts: TextPart[] = [];
	let at = 0;
	let literal = "";
	while (at < raw.length) {
		const open = raw.indexOf("{", at);
		if (open < 0) {
			literal += raw.slice(at);
			break;
		}
		literal += raw.slice(at, open);
		const close = closingBrace(raw, open);
		// The expression being written: what comes before it is drawn, it is not yet.
		if (close < 0) break;
		if (literal) parts.push(literal);
		literal = "";
		const part = expressionOf(raw.slice(open + 1, close - 1).trim());
		if (part.error) problems.push(`{${part.source}}: ${part.error}`);
		parts.push(part);
		at = close;
	}
	if (literal) parts.push(literal);
	return parts.map((part) => (typeof part === "string" ? jsxText(part) : part)).filter((part) => part !== "");
}

/** Babel's rule for JSX text, so a model's habit of indenting markup does not end up on screen. */
function jsxText(part: string): string {
	if (!part.includes("\n")) return part;
	const lines = part.split(/\r?\n/);
	return lines
		.map((line, at) => {
			let kept = line.replace(/\t/g, " ");
			if (at > 0) kept = kept.replace(/^ +/, "");
			if (at < lines.length - 1) kept = kept.replace(/ +$/, "");
			return kept;
		})
		.filter(Boolean)
		.join(" ");
}

const NAME = /^[A-Za-z][\w.-]*/;

/**
 * Attributes from just after the tag name to the tag's end. `end` is the index past `>` (and the
 * tag closes itself when `/>`), or `null` when the tag is still being written.
 */
function readTag(source: string, start: number): { props: Record<string, PropValue>; end: number; selfClosing: boolean; problems: string[] } | null {
	const props: Record<string, PropValue> = {};
	const problems: string[] = [];
	let at = start;
	for (;;) {
		while (at < source.length && /\s/.test(source[at]!)) at++;
		if (at >= source.length) return null;
		if (source[at] === ">") return { props, end: at + 1, selfClosing: false, problems };
		if (source.startsWith("/>", at)) return { props, end: at + 2, selfClosing: true, problems };
		if (source[at] === "/") {
			if (at + 1 >= source.length) return null;
			at++;
			continue;
		}
		const name = NAME.exec(source.slice(at));
		if (!name) {
			problems.push(`unexpected "${source[at]}" inside a tag`);
			at++;
			continue;
		}
		at += name[0].length;
		while (at < source.length && /\s/.test(source[at]!)) at++;
		if (at >= source.length) return null;
		if (source[at] !== "=") {
			props[name[0]] = { kind: "flag" };
			continue;
		}
		at++;
		while (at < source.length && /\s/.test(source[at]!)) at++;
		if (at >= source.length) return null;
		const quote = source[at]!;
		if (quote === '"' || quote === "'") {
			const close = source.indexOf(quote, at + 1);
			if (close < 0) return null;
			props[name[0]] = { kind: "text", text: source.slice(at + 1, close) };
			at = close + 1;
		} else if (quote === "{") {
			const close = closingBrace(source, at);
			if (close < 0) return null;
			const value = expressionOf(source.slice(at + 1, close - 1).trim());
			if (value.error) problems.push(`${name[0]}={${value.source}}: ${value.error}`);
			props[name[0]] = { kind: "expression", ...value };
			at = close;
		} else {
			// Unquoted, as HTML allows: up to the next space or the tag's end.
			const value = /^[^\s>]+/.exec(source.slice(at))![0].replace(/\/$/, "");
			props[name[0]] = { kind: "text", text: value };
			at += value.length;
		}
	}
}

export function parseBlock(source: string): ParsedBlock {
	const problems: string[] = [];
	const root: UiElement = { kind: "element", name: "", props: {}, children: [], open: true };
	const stack: UiElement[] = [root];
	let at = 0;
	const flushText = (raw: string) => {
		const parts = textParts(raw, problems);
		if (!parts.length) return;
		// One run of text, even when a `<` inside an expression made it arrive in pieces.
		const children = stack.at(-1)!.children;
		const last = children.at(-1);
		if (last?.kind === "text") last.parts.push(...parts);
		else children.push({ kind: "text", parts });
	};
	while (at < source.length) {
		const next = source.indexOf("<", at);
		if (next < 0) {
			flushText(source.slice(at));
			break;
		}
		// A `<` inside an expression in text (`{a < b}`) is not a tag.
		const brace = source.lastIndexOf("{", next);
		if (brace >= at && source.lastIndexOf("}", next) < brace) {
			const close = closingBrace(source, brace);
			if (close < 0) {
				flushText(source.slice(at));
				break;
			}
			if (close > next) {
				flushText(source.slice(at, close));
				at = close;
				continue;
			}
		}
		if (next > at) flushText(source.slice(at, next));
		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			if (end < 0) break;
			at = end + 3;
			continue;
		}
		if (source[next + 1] === "/") {
			const end = source.indexOf(">", next);
			if (end < 0) break;
			const name = source.slice(next + 2, end).trim();
			const depth = stack.findLastIndex((element) => element.name === name);
			if (depth > 0) {
				for (const unclosed of stack.slice(depth + 1)) problems.push(`<${unclosed.name}> was closed by </${name}>; close it before its parent`);
				for (const element of stack.splice(depth)) element.open = false;
			} else problems.push(`</${name}> closes nothing`);
			at = end + 1;
			continue;
		}
		const name = NAME.exec(source.slice(next + 1));
		if (!name) {
			// Not a tag after all — a `<` in a sentence, or the first character of one being written.
			if (next + 1 >= source.length) break;
			flushText("<");
			at = next + 1;
			continue;
		}
		const tag = readTag(source, next + 1 + name[0].length);
		if (!tag) break;
		problems.push(...tag.problems);
		const element: UiElement = { kind: "element", name: name[0], props: tag.props, children: [], open: !tag.selfClosing };
		stack.at(-1)!.children.push(element);
		if (!tag.selfClosing) stack.push(element);
		at = tag.end;
	}
	return { nodes: root.children, problems };
}
