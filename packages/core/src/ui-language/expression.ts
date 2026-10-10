/**
 * The expressions inside an interface block: `{budget * 12}`, `when={tab == "detail"}`.
 *
 * Parsed and evaluated here rather than handed to `new Function`: the block is written by a model
 * whose input came from web pages and files, and a reply is not a place code should run. What is
 * here is what a form needs — arithmetic, comparisons, a choice, reading a field — and nothing that
 * reaches outside the values it is given: no assignment, no `this`, no prototypes, and calls only to
 * the functions listed below.
 *
 * `==` is `===`. A model writes `==` out of habit, and JavaScript's coercing kind would make
 * `"0" == 0` and `"" == 0` both true — never what a form means.
 */

export type Expression =
	| { kind: "literal"; value: unknown }
	| { kind: "name"; name: string }
	| { kind: "array"; items: Expression[] }
	| { kind: "object"; entries: [string, Expression][] }
	| { kind: "member"; target: Expression; key: Expression }
	| { kind: "call"; name: string; args: Expression[] }
	| { kind: "unary"; op: string; operand: Expression }
	| { kind: "binary"; op: string; left: Expression; right: Expression }
	| { kind: "choice"; test: Expression; yes: Expression; no: Expression };

/** The functions an expression may call. One line each in the prompt, so each has to earn it. */
export const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
	round: (value, digits = 0) => roundTo(num(value), num(digits)),
	floor: (value) => Math.floor(num(value)),
	ceil: (value) => Math.ceil(num(value)),
	abs: (value) => Math.abs(num(value)),
	min: (...values) => Math.min(...spread(values)),
	max: (...values) => Math.max(...spread(values)),
	sum: (...values) => spread(values).reduce((total, value) => total + value, 0),
	avg: (...values) => {
		const list = spread(values);
		return list.length ? list.reduce((total, value) => total + value, 0) / list.length : 0;
	},
	len: (value) => (Array.isArray(value) || typeof value === "string" ? value.length : 0),
	fixed: (value, digits = 0) => num(value).toFixed(Math.min(20, Math.max(0, Math.trunc(num(digits))))),
	fmt: (value, digits) => num(value).toLocaleString(undefined, digits === undefined ? undefined : { minimumFractionDigits: num(digits), maximumFractionDigits: num(digits) }),
	join: (value, separator = ", ") => (Array.isArray(value) ? value.map((item) => text(item)).join(text(separator)) : text(value)),
};

const num = (value: unknown): number => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "boolean" ? Number(value) : Number.NaN);
const roundTo = (value: number, digits: number) => {
	const scale = 10 ** Math.min(12, Math.max(0, Math.trunc(digits)));
	return Math.round(value * scale) / scale;
};
/** `max(a, b)` and `max(list)` both: a model writes either, and both mean the same thing. */
const spread = (values: unknown[]): number[] => (values.length === 1 && Array.isArray(values[0]) ? values[0] : values).map(num).filter((value) => !Number.isNaN(value));

/** How a value reads when it lands in text: no `undefined`, no `[object Object]`. */
export function text(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return value.map(text).join(", ");
	return JSON.stringify(value);
}

/** Longer than any form needs; a bound so a pathological one cannot stall the frame that draws it. */
const MAX_LENGTH = 4000;

type Token = { kind: "number" | "string" | "name" | "op"; value: string; at: number };

const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "??", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}"];

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at]!;
		if (/\s/.test(char)) {
			at++;
			continue;
		}
		const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(at));
		if (number) {
			tokens.push({ kind: "number", value: number[0], at });
			at += number[0].length;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let value = "";
			let end = at + 1;
			for (; end < source.length && source[end] !== char; end++) {
				if (source[end] === "\\" && end + 1 < source.length) {
					const next = source[++end]!;
					value += next === "n" ? "\n" : next === "t" ? "\t" : next;
				} else value += source[end];
			}
			if (end >= source.length) throw new SyntaxError("unterminated string");
			tokens.push({ kind: "string", value, at });
			at = end + 1;
			continue;
		}
		const name = /^[A-Za-z_$À-￿][\w$À-￿]*/.exec(source.slice(at));
		if (name) {
			tokens.push({ kind: "name", value: name[0], at });
			at += name[0].length;
			continue;
		}
		const op = OPERATORS.find((candidate) => source.startsWith(candidate, at));
		if (!op) throw new SyntaxError(`unexpected "${char}"`);
		tokens.push({ kind: "op", value: op === "===" ? "==" : op === "!==" ? "!=" : op, at });
		at += op.length;
	}
	return tokens;
}

/** Binding power of each binary operator; higher binds tighter. */
const BINARY: Record<string, number> = { "??": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, "<=": 5, ">": 5, ">=": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7 };

export type Parsed = { ok: true; expression: Expression } | { ok: false; error: string };

export function parseExpression(source: string): Parsed {
	if (source.length > MAX_LENGTH) return { ok: false, error: "expression too long" };
	try {
		const tokens = tokenize(source);
		if (!tokens.length) return { ok: false, error: "empty expression" };
		let at = 0;
		const peek = (value?: string) => (value === undefined ? tokens[at] : tokens[at]?.kind === "op" && tokens[at]!.value === value ? tokens[at] : undefined);
		const expect = (value: string) => {
			if (!peek(value)) throw new SyntaxError(`expected "${value}"${tokens[at] ? ` before "${tokens[at]!.value}"` : " at the end"}`);
			at++;
		};
		const list = (close: string, item: () => void) => {
			while (!peek(close)) {
				item();
				if (!peek(close)) expect(",");
			}
			at++;
		};
		const primary = (): Expression => {
			const token = tokens[at++];
			if (!token) throw new SyntaxError("unexpected end");
			if (token.kind === "number") return { kind: "literal", value: Number(token.value) };
			if (token.kind === "string") return { kind: "literal", value: token.value };
			if (token.kind === "name") {
				if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
				if (token.value === "null" || token.value === "undefined") return { kind: "literal", value: null };
				if (peek("(")) {
					at++;
					const args: Expression[] = [];
					list(")", () => args.push(choice()));
					return { kind: "call", name: token.value, args };
				}
				return { kind: "name", name: token.value };
			}
			if (token.value === "(") {
				const inner = choice();
				expect(")");
				return inner;
			}
			if (token.value === "[") {
				const items: Expression[] = [];
				list("]", () => items.push(choice()));
				return { kind: "array", items };
			}
			if (token.value === "{") {
				const entries: [string, Expression][] = [];
				list("}", () => {
					const key = tokens[at++];
					if (!key || key.kind === "op" || key.kind === "number") throw new SyntaxError("expected a key");
					if (peek(":")) {
						at++;
						entries.push([key.value, choice()]);
					} else if (key.kind === "name") entries.push([key.value, { kind: "name", name: key.value }]);
					else throw new SyntaxError(`expected ":" after "${key.value}"`);
				});
				return { kind: "object", entries };
			}
			if (token.value === "!" || token.value === "-" || token.value === "+") return { kind: "unary", op: token.value, operand: postfix(primary()) };
			throw new SyntaxError(`unexpected "${token.value}"`);
		};
		const postfix = (target: Expression): Expression => {
			for (;;) {
				if (peek(".")) {
					at++;
					const key = tokens[at++];
					if (key?.kind !== "name") throw new SyntaxError('expected a name after "."');
					target = { kind: "member", target, key: { kind: "literal", value: key.value } };
				} else if (peek("[")) {
					at++;
					const key = choice();
					expect("]");
					target = { kind: "member", target, key };
				} else return target;
			}
		};
		const binary = (floor: number): Expression => {
			let left = postfix(primary());
			for (;;) {
				const token = tokens[at];
				const power = token?.kind === "op" ? BINARY[token.value] : undefined;
				if (power === undefined || power <= floor) return left;
				at++;
				left = { kind: "binary", op: token!.value, left, right: binary(power) };
			}
		};
		const choice = (): Expression => {
			const test = binary(0);
			if (!peek("?")) return test;
			at++;
			const yes = choice();
			expect(":");
			return { kind: "choice", test, yes, no: choice() };
		};
		const expression = choice();
		if (at < tokens.length) throw new SyntaxError(`unexpected "${tokens[at]!.value}"`);
		return { ok: true, expression };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Keys that lead from a value to the machinery behind it. */
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function member(target: unknown, key: unknown): unknown {
	if (typeof key !== "string" && typeof key !== "number") return undefined;
	const name = String(key);
	if (FORBIDDEN.has(name)) return undefined;
	if (typeof target === "string") return name === "length" ? target.length : /^\d+$/.test(name) ? target[Number(name)] : undefined;
	if (Array.isArray(target)) return name === "length" ? target.length : /^-?\d+$/.test(name) ? target.at(Number(name)) : undefined;
	if (target && typeof target === "object" && Object.getPrototypeOf(target) === Object.prototype && Object.hasOwn(target, name)) return (target as Record<string, unknown>)[name];
	return undefined;
}

function add(left: unknown, right: unknown): unknown {
	if (typeof left === "string" || typeof right === "string") return text(left) + text(right);
	return num(left) + num(right);
}

/**
 * The value of `expression` with `scope` as its names. Never throws: a name that is not there is
 * `undefined`, a function that is not listed is `undefined` — the block draws what it can.
 */
export function evaluate(expression: Expression, scope: Readonly<Record<string, unknown>>): unknown {
	switch (expression.kind) {
		case "literal":
			return expression.value;
		case "name":
			return Object.hasOwn(scope, expression.name) ? scope[expression.name] : undefined;
		case "array":
			return expression.items.map((item) => evaluate(item, scope));
		case "object":
			return Object.fromEntries(expression.entries.filter(([key]) => !FORBIDDEN.has(key)).map(([key, value]) => [key, evaluate(value, scope)]));
		case "member":
			return member(evaluate(expression.target, scope), evaluate(expression.key, scope));
		case "call": {
			const run = Object.hasOwn(FUNCTIONS, expression.name) ? FUNCTIONS[expression.name] : undefined;
			return run ? run(...expression.args.map((arg) => evaluate(arg, scope))) : undefined;
		}
		case "unary": {
			const value = evaluate(expression.operand, scope);
			return expression.op === "!" ? !value : expression.op === "-" ? -num(value) : num(value);
		}
		case "choice":
			return evaluate(expression.test, scope) ? evaluate(expression.yes, scope) : evaluate(expression.no, scope);
		case "binary": {
			const left = evaluate(expression.left, scope);
			if (expression.op === "&&") return left ? evaluate(expression.right, scope) : left;
			if (expression.op === "||") return left ? left : evaluate(expression.right, scope);
			if (expression.op === "??") return left ?? evaluate(expression.right, scope);
			const right = evaluate(expression.right, scope);
			switch (expression.op) {
				case "==":
					return left === right;
				case "!=":
					return left !== right;
				case "+":
					return add(left, right);
				case "-":
					return num(left) - num(right);
				case "*":
					return num(left) * num(right);
				case "/":
					return num(left) / num(right);
				case "%":
					return num(left) % num(right);
				default:
					// The comparisons: two strings compare as text, anything else as numbers.
					return typeof left === "string" && typeof right === "string" ? compare(expression.op, left, right) : compare(expression.op, num(left), num(right));
			}
		}
	}
}

function compare<T extends string | number>(op: string, left: T, right: T): boolean {
	return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
}

/** The names an expression reads and the functions it calls, for the check that runs before drawing. */
export function references(expression: Expression, into: { names: Set<string>; calls: Set<string> } = { names: new Set(), calls: new Set() }) {
	switch (expression.kind) {
		case "name":
			into.names.add(expression.name);
			break;
		case "array":
			for (const item of expression.items) references(item, into);
			break;
		case "object":
			for (const [, value] of expression.entries) references(value, into);
			break;
		case "member":
			references(expression.target, into);
			references(expression.key, into);
			break;
		case "call":
			into.calls.add(expression.name);
			for (const arg of expression.args) references(arg, into);
			break;
		case "unary":
			references(expression.operand, into);
			break;
		case "binary":
			references(expression.left, into);
			references(expression.right, into);
			break;
		case "choice":
			references(expression.test, into);
			references(expression.yes, into);
			references(expression.no, into);
			break;
	}
	return into;
}
