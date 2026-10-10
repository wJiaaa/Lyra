/**
 * An interface block measured against the catalog: what will not draw the way it was written, and
 * the props as the components will use them.
 *
 * Two readers, one set of rules. The desktop reads props through `readProps` as it draws; the model
 * is told on its next turn what `checkBlock` found (`notes.ts`), so a prop that went nowhere is said
 * once instead of being written again in every reply that follows.
 */

import { COMMON_PROPS, COMPONENTS, type PropSpec } from "./catalog.ts";
import { evaluate, FUNCTIONS, parseExpression, references, text, type Expression } from "./expression.ts";
import { parseBlock, type PropValue, type UiElement, type UiNode } from "./parse.ts";

/** More than this and the model is better off reading the catalog again than a list. */
const MAX_PROBLEMS = 8;

/** Quoted text may hold `{expression}` too: `send="Plan for {city}"`. Split into its pieces. */
export function templateParts(value: string): (string | Expression)[] | null {
	if (!value.includes("{")) return null;
	const parts: (string | Expression)[] = [];
	let at = 0;
	for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
		const parsed = parseExpression(match[1]!.trim());
		if (!parsed.ok) continue;
		if (match.index > at) parts.push(value.slice(at, match.index));
		parts.push(parsed.expression);
		at = match.index + match[0].length;
	}
	if (at < value.length) parts.push(value.slice(at));
	return parts;
}

function fill(value: string, scope: Readonly<Record<string, unknown>>): string {
	const parts = templateParts(value);
	return parts ? parts.map((part) => (typeof part === "string" ? part : text(evaluate(part, scope)))).join("") : value;
}

function coerce(spec: PropSpec, value: unknown): unknown {
	const type = spec.type;
	if (value === undefined || value === null) return undefined;
	if (typeof type !== "string") return type.includes(String(value)) ? String(value) : undefined;
	switch (type) {
		case "text":
			return text(value);
		case "number": {
			const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
			return Number.isFinite(number) ? number : undefined;
		}
		case "boolean":
			return value === "false" ? false : Boolean(value);
		case "array":
			return Array.isArray(value) ? value : undefined;
		case "object":
			return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
		default:
			return value;
	}
}

function specOf(element: UiElement, prop: string): PropSpec | undefined {
	return COMPONENTS[element.name]?.props[prop] ?? COMMON_PROPS[prop];
}

/** The value a prop holds right now, before it is fitted to its type. */
function rawValue(value: PropValue, type: PropSpec["type"], scope: Readonly<Record<string, unknown>>): unknown {
	if (value.kind === "flag") return true;
	if (value.kind === "expression") return value.expression ? evaluate(value.expression, scope) : undefined;
	return type === "text" || type === "value" ? fill(value.text, scope) : value.text;
}

/** The element's props as its component will use them: evaluated, fitted to their types, the unusable left out. */
export function readProps(element: UiElement, scope: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(element.props)) {
		const spec = specOf(element, name);
		if (!spec) continue;
		const fitted = coerce(spec, rawValue(value, spec.type, scope));
		if (fitted !== undefined) out[name] = fitted;
	}
	return out;
}

/** Everything a block declares as state, and what each starts as. */
export function initialState(nodes: UiNode[]): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	const visit = (node: UiNode) => {
		if (node.kind !== "element") return;
		const spec = COMPONENTS[node.name];
		const key = spec?.declares ? node.props[spec.declares] : undefined;
		if (key?.kind === "text" && key.text && !(key.text in state)) {
			const props = readProps(node, state);
			state[key.text] = props.value ?? emptyValue(node, props);
		}
		node.children.forEach(visit);
	};
	nodes.forEach(visit);
	return state;
}

function emptyValue(element: UiElement, props: Record<string, unknown>): unknown {
	switch (element.name) {
		case "Toggle":
			return false;
		case "Slider":
			return props.min ?? 0;
		case "Choice":
			return props.multiple ? [] : "";
		case "Tabs": {
			const first = element.children.find((child): child is UiElement => child.kind === "element" && child.name === "Tab");
			const title = first?.props.title;
			return title?.kind === "text" ? title.text : "";
		}
		default:
			return "";
	}
}

function describe(type: PropSpec["type"]): string {
	return typeof type === "string" ? type : type.map((value) => `"${value}"`).join(" | ");
}

function closest(name: string, among: string[]): string | undefined {
	const lower = name.toLowerCase();
	return among.find((candidate) => candidate.toLowerCase() === lower) ?? among.find((candidate) => lower.includes(candidate.toLowerCase()));
}

/**
 * What in `source` will not draw as written. `complete`: the block's closing fence is in — before
 * that, an element without its closing tag is one still being written, not a mistake.
 */
export function checkBlock(source: string, complete = true): string[] {
	const parsed = parseBlock(source);
	const problems = [...parsed.problems];
	const declared = new Set(Object.keys(initialState(parsed.nodes)));
	const say = (path: string, problem: string) => problems.push(`${path}: ${problem}`);

	const expression = (path: string, label: string, value: Expression, names: Set<string>) => {
		const found = references(value);
		for (const call of found.calls) if (!Object.hasOwn(FUNCTIONS, call)) say(path, `${label} calls ${call}(), which is not a function here (${Object.keys(FUNCTIONS).join(", ")})`);
		for (const name of found.names) if (!names.has(name)) say(path, `${label} reads "${name}", which no input declares${names.size ? ` (state: ${[...names].join(", ")})` : ""}`);
		return found.names.size === 0 && found.calls.size === 0;
	};

	const visit = (node: UiNode, parent: UiElement | null, names: Set<string>, path: string) => {
		if (node.kind === "text") {
			for (const part of node.parts) if (typeof part !== "string" && part.expression) expression(path, `{${part.source}}`, part.expression, names);
			return;
		}
		const here = path ? `${path} > ${node.name}` : node.name;
		const spec = COMPONENTS[node.name];
		if (!spec) {
			const near = closest(node.name, Object.keys(COMPONENTS));
			say(here, `not a component${near ? ` — did you mean ${near}?` : ""}; it was not drawn`);
			return;
		}
		if (complete && node.open) say(here, "never closed");
		if (spec.within && parent?.name !== spec.within) say(here, `must be directly inside ${spec.within}`);
		if (parent && COMPONENTS[parent.name]?.holds && COMPONENTS[parent.name]!.holds !== node.name) say(here, `${parent.name} holds only ${COMPONENTS[parent.name]!.holds}`);
		for (const [prop, propSpec] of Object.entries(spec.props)) if (propSpec.required && !(prop in node.props)) say(here, `needs ${prop}`);
		if (node.name === "Button" && !("send" in node.props) && !("set" in node.props)) say(here, "does nothing without send or set");

		for (const [prop, value] of Object.entries(node.props)) {
			const propSpec = specOf(node, prop);
			if (!propSpec) {
				const near = closest(prop, [...Object.keys(spec.props), ...Object.keys(COMMON_PROPS)]);
				say(here, `has no prop "${prop}"${near ? ` — did you mean ${near}?` : ""}; it was ignored`);
				continue;
			}
			const label = `${prop}=`;
			if (value.kind === "expression") {
				if (!value.expression) continue;
				// A constant can be checked now; one that reads state is checked as it is drawn.
				if (expression(here, label, value.expression, names) && coerce(propSpec, evaluate(value.expression, {})) === undefined && evaluate(value.expression, {}) !== undefined)
					say(here, `${prop} must be ${describe(propSpec.type)}; it was ignored`);
				continue;
			}
			if (value.kind === "text") {
				for (const part of templateParts(value.text) ?? []) if (typeof part !== "string") expression(here, label, part, names);
				if (propSpec.type === "array" || propSpec.type === "object") say(here, `${prop} must be written as ${prop}={…}, not in quotes; it was ignored`);
				else if (!templateParts(value.text) && coerce(propSpec, value.text) === undefined) say(here, `${prop} must be ${describe(propSpec.type)}, not "${value.text}"; it was ignored`);
			}
		}

		const elements = node.children.filter((child): child is UiElement => child.kind === "element");
		if (spec.children === "none" && node.children.length) say(here, "takes no children; they were not drawn");
		if (spec.children === "text" && elements.length) say(here, `holds text only; ${elements.map((child) => `<${child.name}>`).join(", ")} inside it were not drawn`);

		let inner = names;
		if (node.name === "Each") {
			inner = new Set(names);
			for (const [prop, fallback] of [["as", "item"], ["index", null]] as const) {
				const value = node.props[prop];
				const name = value?.kind === "text" ? value.text : fallback;
				if (name) inner.add(name);
			}
		}
		for (const child of node.children) visit(child, node, inner, here);
	};
	for (const node of parsed.nodes) visit(node, null, declared, "");
	const unique = [...new Set(problems)];
	return unique.length > MAX_PROBLEMS ? [...unique.slice(0, MAX_PROBLEMS), `…and ${unique.length - MAX_PROBLEMS} more`] : unique;
}
