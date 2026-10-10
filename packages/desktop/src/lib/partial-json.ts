/**
 * The value a JSON text is going to be, read before it is finished — a tool call's arguments while
 * the model is still writing them.
 *
 * What is complete comes back as it is; the string being written comes back as far as it has got;
 * a key with no value yet, a number that may still be growing, a `tru` are left out. Never throws:
 * a prefix is not an error, and neither is anything after the first value.
 */

const END = Symbol("end");
const SPECIAL = /["\\]/g;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

export function partialJson(text: string): unknown {
	let at = 0;
	const space = () => {
		while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++;
	};

	/** From an opening quote to its closing one, or to the end of the text. */
	function string(): { value: string; done: boolean } {
		at++;
		let value = "";
		while (at < text.length) {
			SPECIAL.lastIndex = at;
			const found = SPECIAL.exec(text);
			const stop = found ? found.index : text.length;
			value += text.slice(at, stop);
			at = stop;
			if (!found) break;
			if (found[0] === '"') {
				at++;
				return { value, done: true };
			}
			const escaped = text[at + 1];
			// A backslash or `\u12` cut off at the end is the next character, not yet written.
			if (escaped === undefined) return { value, done: false };
			if (escaped === "u") {
				const hex = text.slice(at + 2, at + 6);
				if (hex.length < 4) return { value, done: false };
				value += String.fromCharCode(Number.parseInt(hex, 16));
				at += 6;
				continue;
			}
			value += ESCAPES[escaped] ?? escaped;
			at += 2;
		}
		at = text.length;
		return { value, done: false };
	}

	function object(): Record<string, unknown> {
		at++;
		const out: Record<string, unknown> = {};
		while (true) {
			space();
			const next = text[at];
			if (next === undefined) return out;
			if (next === "}") {
				at++;
				return out;
			}
			if (next === ",") {
				at++;
				continue;
			}
			if (next !== '"') return out;
			const key = string();
			if (!key.done) return out;
			space();
			if (text[at] !== ":") return out;
			at++;
			const item = value();
			if (item !== END) out[key.value] = item;
			if (at >= text.length) return out;
		}
	}

	function array(): unknown[] {
		at++;
		const out: unknown[] = [];
		while (true) {
			space();
			const next = text[at];
			if (next === undefined) return out;
			if (next === "]") {
				at++;
				return out;
			}
			if (next === ",") {
				at++;
				continue;
			}
			const before = at;
			const item = value();
			if (item !== END) out.push(item);
			if (at >= text.length || at === before) return out;
		}
	}

	function value(): unknown {
		space();
		const next = text[at];
		if (next === undefined) return END;
		if (next === "{") return object();
		if (next === "[") return array();
		if (next === '"') return string().value;
		const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at, at + 32));
		if (!literal) {
			at = text.length;
			return END;
		}
		at += literal[0].length;
		// `12` at the very end may be the start of `125`.
		if (at >= text.length && /\d$/.test(literal[0])) return END;
		return JSON.parse(literal[0]);
	}

	const result = value();
	return result === END ? undefined : result;
}
