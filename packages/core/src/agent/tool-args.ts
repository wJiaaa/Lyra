/**
 * Meeting a tool call halfway before it runs.
 *
 * Not a validator. The tools accept more than their schemas say — aliases (`query` for grep's
 * `pattern`), numbers as strings, a path under three names — and a front door that rejected on the
 * schema would turn every one of those working calls into an error. So this layer only repairs what
 * is unambiguous, and when a call does fail, says what the tool would have accepted.
 */

import type { JsonSchema, Tool, ToolResult } from "../types.ts";

/**
 * The tool a call names, forgiving case.
 *
 * Models trained on other harnesses call `Read` and `Bash`. A unique case-insensitive match is the
 * tool they meant; two matches would be a guess, so that stays unresolved.
 */
export function resolveTool(byName: ReadonlyMap<string, Tool>, name: string): Tool | undefined {
	const exact = byName.get(name);
	if (exact) return exact;
	const lower = name.toLowerCase();
	const matches = [...byName.values()].filter((tool) => tool.name.toLowerCase() === lower);
	return matches.length === 1 ? matches[0] : undefined;
}

export function unknownToolMessage(name: string, tools: readonly Tool[]): string {
	return `Tool "${name}" is not available in this session. Available tools: ${tools.map((tool) => tool.name).join(", ")}.`;
}

/**
 * Top-level arguments turned into the type the schema declares, where the intent is unambiguous.
 *
 * The common case is an array or object sent as a JSON string (`"todos": "[{…}]"`), which weaker
 * models and some relays produce and which every tool would otherwise refuse. Also numeric and
 * boolean strings. Anything that does not convert cleanly is left exactly as it was, for the tool
 * to judge. Returns the same object when nothing changed.
 */
export function coerceArguments(args: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties) return args;
	let out: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(args)) {
		const sub = properties[key];
		if (!sub || typeof value !== "string") continue;
		const coerced = coerce(value, sub.type);
		if (coerced === undefined) continue;
		out ??= { ...args };
		out[key] = coerced;
	}
	return out ?? args;
}

function coerce(value: string, type: unknown): unknown {
	const text = value.trim();
	if (type === "array" || type === "object") {
		if (!text.startsWith(type === "array" ? "[" : "{")) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			const isArray = Array.isArray(parsed);
			if (type === "array" ? isArray : parsed !== null && typeof parsed === "object" && !isArray) return parsed;
		} catch {
			// Not JSON after all; the tool gets the string.
		}
		return undefined;
	}
	if (type === "number" || type === "integer") {
		if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
		const number = Number(text);
		return type === "integer" && !Number.isInteger(number) ? undefined : number;
	}
	if (type === "boolean") return text === "true" ? true : text === "false" ? false : undefined;
	return undefined;
}

/**
 * A failed call, told which parameters the tool takes — only when the arguments missed its schema.
 *
 * Said after the failure rather than instead of the call: the tool may well have accepted an alias,
 * and a call that worked must not be refused for spelling. When it did fail, the model's next
 * attempt is usually a guess at field names; this replaces the guess with the list.
 */
export function withParameterHint(result: ToolResult, tool: Tool, args: Record<string, unknown>): ToolResult {
	const properties = tool.parameters.properties;
	if (!result.isError || !properties) return result;
	const required = tool.parameters.required ?? [];
	const missing = required.filter((key) => args[key] === undefined);
	const unknown = Object.keys(args).filter((key) => !(key in properties));
	if (missing.length === 0 && unknown.length === 0) return result;
	const accepted = Object.keys(properties).map((key) => (required.includes(key) ? `${key} (required)` : key));
	const parts = [`\`${tool.name}\` accepts: ${accepted.join(", ")}.`];
	if (missing.length > 0) parts.push(`Missing: ${missing.join(", ")}.`);
	if (unknown.length > 0) parts.push(`Not a parameter: ${unknown.join(", ")}.`);
	return { ...result, content: [...result.content, { type: "text", text: `\n[${parts.join(" ")}]` }] };
}
