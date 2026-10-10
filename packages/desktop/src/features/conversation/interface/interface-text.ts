/**
 * A reply with interface blocks, as text for the clipboard.
 *
 * The copy button used to hand over the reply's source, and a block's source is markup — pasted into
 * a note or a mail it was `<Grid cols={3}><Stat label=…`, which says nothing to anyone reading it
 * there. Copied, a block is what it showed: its words, its figures as `label: value`, its tables and
 * charts as Markdown tables, and what the reader set in it as it stands now. Buttons are left out —
 * there is nothing to press on a clipboard.
 */

import { chartData, COMPONENTS, evaluate, initialState, parseBlock, readProps, text, type UiElement, type UiNode } from "@plume/core/ui-language";
import { parseMarkdownChunks } from "../../../lib/markdown/blocks.ts";
import { recall, stateKey } from "./interface-state.ts";

/** The fence's language tag. */
export function isInterface(lang: string): boolean {
	return lang.trim().toLowerCase() === "ui";
}

/** As many as the block draws — see `MAX_REPEAT` in `render.tsx`. */
const MAX_REPEAT = 200;

type Values = Readonly<Record<string, unknown>>;

function words(nodes: UiNode[], values: Values): string {
	return nodes
		.map((node) => (node.kind === "text" ? node.parts.map((part) => (typeof part === "string" ? part : part.expression ? text(evaluate(part.expression, values)) : "")).join("") : ""))
		.join("")
		.trim();
}

function table(header: string[], rows: string[][]): string {
	const cell = (value: string) => value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
	const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
	return [line(header), `|${header.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n");
}

/** The label of a choice's value: the option's own label when it has one. */
function chosen(options: unknown, value: unknown): string {
	const list = Array.isArray(options) ? options : [];
	const label = (item: unknown) => {
		const found = list.find((option) => (option && typeof option === "object" ? (option as { value?: unknown }).value : option) === item);
		return found && typeof found === "object" ? text((found as { label?: unknown }).label ?? item) : text(item);
	};
	return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(label).join(", ");
}

const join = (parts: string[], between: string) => parts.filter(Boolean).join(between);

function nodes(list: UiNode[], values: Values, between = "\n"): string {
	return join(list.map((node) => (node.kind === "text" ? words([node], values) : element(node, values))), between);
}

function element(node: UiElement, values: Values): string {
	if (!COMPONENTS[node.name]) return "";
	const props = readProps(node, values);
	if ("when" in node.props && !props.when) return "";
	const inner = (between = "\n") => nodes(node.children, values, between);
	const labelled = (value: string) => join([text(props.label ?? ""), value], ": ");
	const value = values[String(props.name)];

	switch (node.name) {
		case "Stack":
		case "Grid":
		case "Tab":
			return inner();
		case "Row":
			return inner(" · ");
		case "Card":
			return join([props.title ? `**${text(props.title)}**` : "", text(props.subtitle ?? ""), inner()], "\n");
		case "Divider":
			// Blank lines round it: right under a line of text, `---` makes that line a heading.
			return "\n---\n";
		case "Tabs":
			// All of them: a copy is read in one piece, with no tabs to switch.
			return join(node.children.map((tab) => (tab.kind === "element" && tab.name === "Tab" ? join([`**${text(readProps(tab, values).title ?? "")}**`, nodes(tab.children, values)], "\n") : "")), "\n\n");
		case "Each": {
			const items = ((props.of as unknown[] | undefined) ?? []).slice(0, MAX_REPEAT);
			const as = (props.as as string | undefined) || "item";
			const index = props.index as string | undefined;
			return join(items.map((item, at) => nodes(node.children, { ...values, [as]: item, ...(index ? { [index]: at } : {}) })), "\n");
		}
		case "Heading":
			return `**${words(node.children, values)}**`;
		case "Text":
		case "Badge":
			return words(node.children, values);
		case "Callout":
			return join([props.title ? `**${text(props.title)}**` : "", inner()], "\n").replace(/^/gm, "> ");
		case "Stat": {
			const delta = props.delta === undefined ? "" : typeof props.delta === "number" && props.delta > 0 ? `+${props.delta}` : text(props.delta);
			return `${join([text(props.label ?? ""), join([text(props.value), delta], " ")], ": ")}${props.hint ? `（${text(props.hint)}）` : ""}`;
		}
		case "Progress": {
			const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
			return labelled(`${Math.round(Math.min(1, Math.max(0, ((props.value as number | undefined) ?? 0) / max)) * 100)}%`);
		}
		case "Table": {
			const records = ((props.data as unknown[] | undefined) ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
			const header = ((props.columns as unknown[] | undefined) ?? (records[0] ? Object.keys(records[0]) : [])).map(text);
			const rows = props.rows ? (props.rows as unknown[]).map((row) => (Array.isArray(row) ? row : [row]).map(text)) : records.map((record) => header.map((key) => text(record[key])));
			return header.length || rows.length ? table(header, rows) : "";
		}
		case "Chart": {
			const { rows, labels, keys } = chartData(props.data as unknown[] | undefined, props.x as string | undefined, props.y);
			return rows.length && keys.length ? table([text(props.x ?? ""), ...keys], rows.map((row, at) => [labels[at]!, ...keys.map((key) => text(row[key]))])) : "";
		}
		case "Input":
		case "Slider":
			return labelled(value === undefined || value === "" ? "" : `${text(value)}${node.name === "Slider" ? text(props.unit ?? "") : ""}`);
		case "Select":
		case "Choice":
			return labelled(chosen(props.options, value));
		case "Toggle":
			return labelled(value === true ? "✓" : "✗");
		default:
			return "";
	}
}

/** One block as text, with the values it has now: what the reader set over what it started with. */
export function interfaceText(source: string, set: Record<string, unknown> = {}): string {
	const { nodes: parsed } = parseBlock(source);
	return nodes(parsed, { ...initialState(parsed), ...set }, "\n\n");
}

/** A reply's text with each finished ```ui block in it as text — see the top of this file. `scope` is the blocks' state key (`InterfaceHost`). */
export function copyableReply(markdown: string, scope: string | null): string {
	if (!/^\s*(```|~~~)+ui\s*$/im.test(markdown)) return markdown;
	return parseMarkdownChunks(markdown)
		.map(({ block, raw }) => {
			if (block.kind !== "code" || block.open || !isInterface(block.lang)) return raw;
			const shown = interfaceText(block.code, recall(stateKey(scope, block.code)).values);
			return shown + raw.slice(raw.trimEnd().length);
		})
		.join("\n");
}
