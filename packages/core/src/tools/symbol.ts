import { errorResult } from "./result.ts";
import { buildIndex, INDEX_VERSION, loadIndex, saveIndex, searchIndex, type SymbolIndex } from "../index/symbols.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

const INDEX_KEY = "symbolIndex";
/**
 * How long an index on disk is trusted by a new session.
 *
 * It used to be trusted forever: one built on 10-07 was still answering a week later, missing every
 * definition written since. Rebuilding this repository takes about 0.2 s, so a stale answer is the
 * expensive one — a "not found" for code that exists sends the agent back to grep.
 */
const MAX_AGE_MS = 10 * 60_000;

interface SymbolArgs {
	name: string;
	kind?: string;
	limit?: number;
}

/** Build once per session, then reuse; rebuilding on every call would be wasteful. */
async function getIndex(ctx: ToolContext): Promise<SymbolIndex> {
	const cached = ctx.state.get(INDEX_KEY) as SymbolIndex | undefined;
	if (cached) return cached;

	const stored = await loadIndex(ctx.cwd);
	if (stored && stored.version === INDEX_VERSION && Date.now() - stored.builtAt < MAX_AGE_MS) {
		ctx.state.set(INDEX_KEY, stored);
		return stored;
	}

	const built = await buildIndex(ctx.cwd, ctx.signal);
	ctx.state.set(INDEX_KEY, built);
	await saveIndex(built).catch(() => {});
	return built;
}

export const symbolTool: Tool<SymbolArgs> = {
	name: "symbol",
	description:
		"Find where a symbol is declared: file:line for each matching function, class, interface, type or constant, best match first. " +
		"More precise than grepping a name that appears at every call site.",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Symbol name or a fragment of it." },
			kind: {
				type: "string",
				description: "function, class, interface, type, enum, const, def, func, struct or method.",
			},
			limit: { type: "number", description: "Maximum matches. Default 40." },
		},
		required: ["name"],
		additionalProperties: true,
	},
	summarize: (args) => {
		const raw = args as unknown as Record<string, unknown>;
		const name = String(raw.name ?? raw.query ?? raw.symbol ?? raw.pattern ?? "");
		return name ? `Find definition of ${name}` : "Find definition";
	},

	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as unknown as Record<string, unknown>;
		const name = typeof raw.name === "string" && raw.name
			? raw.name
			: typeof raw.query === "string" && raw.query
				? raw.query
				: typeof raw.symbol === "string" && raw.symbol
					? raw.symbol
					: typeof raw.pattern === "string" && raw.pattern
						? raw.pattern
						: "";

		if (!name.trim()) return errorResult("`name` is required.");

		const index = await getIndex(ctx);
		const matches = searchIndex(index, name.trim(), args.kind, args.limit ?? 40);

		if (matches.length === 0) {
			// "Not found" and "never looked" are different answers; the first tells the agent the definition does not exist.
			const why = index.truncated
				? `The index stopped at ${index.symbols.length} symbols, so files after that point were never indexed — use grep.`
				: "It may be defined in a dependency, or declared in a form the index does not recognise — try grep.";
			return {
				content: [
					{
						type: "text",
						text: `No definition found for "${name}" among ${index.symbols.length} indexed symbols across ${index.fileCount} files. ${why}`,
					},
				],
				details: { kind: "symbol", query: name, count: 0 },
			};
		}

		const body = matches.map((m) => `${m.file}:${m.line}  [${m.kind}]  ${m.text}`).join("\n");
		return {
			content: [{ type: "text", text: body }],
			details: { kind: "symbol", query: name, count: matches.length, matches },
		};
	},
};

/** Drop the cached index so the next lookup re-scans. Used after the user rebuilds it. */
export function invalidateIndex(state: Map<string, unknown>): void {
	state.delete(INDEX_KEY);
}
