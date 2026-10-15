import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "../types.ts";
import { displayPath } from "./paths.ts";
import { gitListedFiles } from "./project-files.ts";
import { authorizeRead } from "./read-access.ts";

const MAX_RESULTS = 500;
/**
 * 按修改时间排序最多对多少个匹配做 stat。遍历本身一直走完（只 readdir，便宜），所以总数是准的；
 * 超过这个数时排序只覆盖先找到的这些，结果里明说。以前找到 2000 个就停止遍历，排序和「还有 N 个」
 * 都只基于这一部分，而结果里看不出来。
 */
const SORT_CAP = 10_000;
/** 不在 git 仓库里时才用这张名单；仓库里认 `.gitignore`，见 `project-files.ts`。 */
const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
	"__pycache__", ".venv", "venv", ".turbo", ".cache", "Pods", ".gradle", ".expo",
]);

interface GlobArgs {
	pattern: string;
	description?: string;
	path?: string;
	limit?: number;
}

export const globTool: Tool<GlobArgs> = {
	name: "glob",
	approvalKind: "read",
	description:
		"Find files by name, newest first; to search contents, use grep. Supports `*`, `?`, `**` and `{a,b}`, e.g. `src/**/*.{ts,tsx}`. " +
		"Skips files git ignores (outside a git repository: build and dependency directories).",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern, relative to the search root." },
			description: { type: "string", description: "5-10 word description shown to the user, in plain words and the user's language — not the pattern." },
			path: { type: "string", description: "Directory to search. Defaults to the workspace root." },
			limit: { type: "number", description: "Maximum number of matches. Default 500." },
		},
		additionalProperties: true,
	},
	summarize: (args) => {
		const raw = args as unknown as Record<string, unknown>;
		const term = String(raw.pattern ?? raw.query ?? raw.search ?? extractPattern(raw.description) ?? "");
		return term ? `Find ${term}` : "Find";
	},

	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as unknown as Record<string, unknown>;
		const pattern = typeof raw.pattern === "string" && raw.pattern
			? raw.pattern
			: typeof raw.query === "string" && raw.query
				? raw.query
				: typeof raw.search === "string" && raw.search
					? raw.search
					: typeof raw.description === "string"
						? extractPattern(raw.description)
						: "";

		const path = typeof raw.path === "string" ? raw.path : typeof raw.dir === "string" ? raw.dir : typeof raw.cwd === "string" ? raw.cwd : undefined;

		let root = ctx.cwd;
		if (path) {
			const authorized = await authorizeRead(ctx, path);
			if (!authorized.ok) return errorResult(authorized.message);
			root = authorized.absolute;
		}
		if (!pattern) return errorResult("`pattern` is required. Please specify the glob pattern to search for in the `pattern` parameter, e.g. {\"pattern\": \"**/*.ts\"}.");

		const regex = globToRegExp(pattern);
		const limit = Math.min(args.limit ?? MAX_RESULTS, MAX_RESULTS);
		const found: string[] = [];
		let total = 0;
		// 模式按搜索目录匹配（`path: "src"` 配 `**/*.tsx`），记下的是绝对路径，报出去时再相对工作区根写。
		const consider = (full: string): void => {
			if (!regex.test(relative(root, full).split(sep).join("/"))) return;
			total++;
			if (found.length < SORT_CAP) found.push(full);
		};

		const walk = async (dir: string): Promise<void> => {
			if (ctx.signal?.aborted) return;
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					// Hidden directories are only traversed when the pattern asks for them.
					if (entry.name.startsWith(".") && !pattern.includes("/.") && !pattern.startsWith(".")) continue;
					await walk(full);
					continue;
				}
				if (!entry.isFile()) continue;
				consider(full);
			}
		};

		const listed = await gitListedFiles(root);
		if (listed) for (const full of listed) consider(full);
		else await walk(root);
		const matches: { path: string; mtime: number }[] = [];
		for (let at = 0; at < found.length; at += 64) {
			const batch = found.slice(at, at + 64);
			const infos = await Promise.all(batch.map((full) => stat(full).catch(() => null)));
			batch.forEach((full, index) => matches.push({ path: displayPath(ctx.cwd, full), mtime: infos[index]?.mtimeMs ?? 0 }));
		}
		matches.sort((a, b) => b.mtime - a.mtime);
		const shown = matches.slice(0, limit);

		if (shown.length === 0) {
			return {
				content: [{ type: "text", text: `No files match ${pattern}.` }],
				details: { kind: "glob", count: 0 },
				uneventful: true,
			};
		}

		const footer =
			total > found.length
				? `\n\n[${total} matches in total, ${total - shown.length} not shown; newest-first covers only the first ${found.length} found — narrow the pattern or path]`
				: total > shown.length
					? `\n\n[${total - shown.length} more matches not shown]`
					: "";
		return {
			content: [{ type: "text", text: shown.map((m) => m.path).join("\n") + footer }],
			details: { kind: "glob", pattern, count: total, files: shown.map((m) => m.path) },
		};
	},
};

/**
 * Translate a glob to a regular expression.
 *
 * `**` crosses directory separators, `*` and `?` do not, `{a,b}` expands to alternation, and
 * `[abc]` / `[a-z]` / `[!x]` (or `[^x]`) are character classes, as ripgrep's `--glob` reads them.
 * Everything else is escaped so a pattern like `src/v1.2/*.ts` cannot smuggle regex syntax in.
 *
 * Classes used to be escaped too, and `*[Pp]review*` then looked for the three characters `[Pp]`:
 * it matched nothing and answered "No files match" with a file that matched sitting right there.
 */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` also has to match zero directories, so `**/*.ts` finds `a.ts` at the root.
				if (pattern[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				out += ".*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (char === "[") {
			const close = classEnd(pattern, i);
			if (close !== -1) {
				out += charClass(pattern.slice(i + 1, close));
				i = close + 1;
				continue;
			}
		}
		if (char === "{") {
			const close = pattern.indexOf("}", i);
			if (close !== -1) {
				const options = pattern.slice(i + 1, close).split(",");
				out += `(?:${options.map(escapeRegex).join("|")})`;
				i = close + 1;
				continue;
			}
		}
		out += escapeRegex(char);
		i += 1;
	}
	return new RegExp(`^${out}$`);
}

/** Where the class opened at `open` ends, or -1 if it never does — then `[` is just a character. A `]` right after `[` or `[!` is a member. */
function classEnd(pattern: string, open: number): number {
	let j = open + 1;
	if (pattern[j] === "!" || pattern[j] === "^") j += 1;
	if (pattern[j] === "]") j += 1;
	return pattern.indexOf("]", j);
}

/** A glob class body as a regex class. Negated, it still never matches `/`, the same way `?` does not. */
function charClass(body: string): string {
	const negated = body.startsWith("!") || body.startsWith("^");
	const members = (negated ? body.slice(1) : body).replace(/[\\\][^]/g, "\\$&");
	return negated ? `[^/${members}]` : `[${members}]`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract a glob pattern when the model embeds it in a description string. */
function extractPattern(desc: unknown): string {
	if (typeof desc !== "string" || !desc.trim()) return "";
	const labeled = extractLabeledValue(desc, ["pattern", "glob", "query", "search"]);
	if (labeled) return labeled;
	const quoted = desc.match(/[`'"]([^`'"]*[*?{}][^`'"]*)[`'"]/);
	if (quoted?.[1]) return quoted[1].trim();
	const wildcard = desc.match(/\S*[*?{}][^\s)]*/);
	if (wildcard?.[0]) return wildcard[0].trim();
	/* Fallback: if the model passed the pattern directly as description */
	return desc.trim();
}

function extractLabeledValue(desc: string, labels: string[]): string {
	const names = labels.join("|");
	const quoted = desc.match(new RegExp(`(?:${names})[:=]\\s*[\`'"]([^\\\`'"]+)[\`'"]`, "i"));
	if (quoted?.[1]) return quoted[1].trim();
	const bare = desc.match(new RegExp(`(?:${names})[:=]\\s*(\\S+)`, "i"));
	if (bare?.[1]) return bare[1].replace(/[)\].,;]+$/, "").trim();
	return "";
}
