/**
 * Pull the language marks we actually use out of `simple-icons`, once, into a file we ship.
 *
 * Not an import at runtime. The package carries some three and a half thousand icons, and whether
 * any of them survive to the bundle is a question about the bundler's tree-shaking rather than
 * about what we asked for — a question whose answer changes with a version bump. Forty-six paths
 * extracted here is a number we can see in the diff and measure in the bundle.
 *
 * `simple-icons` is a devDependency for exactly this reason: it runs here, never in the app.
 *
 * **On the marks themselves.** The SVG files are CC0, but the marks are their owners' trademarks,
 * and several are absent for that reason — Oracle's Java, Microsoft's C# and PowerShell have all
 * been removed from the set at the owner's request at one point or another. Those fall back to a
 * neutral glyph rather than being drawn from memory; a wrong logo is worse than no logo. Where a
 * language's own mark is gone but its platform's is not, the platform's is used and named below.
 *
 * Run: node scripts/make-language-icons.mjs
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as icons from "simple-icons";

const OUT = join(import.meta.dirname, "..", "src", "lib", "code", "language-icons.ts");

/**
 * Our language key → the mark to draw for it.
 *
 * A few are deliberately somebody else's mark, and each of those is a judgement rather than a
 * lookup:
 *
 *   - `java` → OpenJDK. Oracle's Java mark is not in the set.
 *   - `cs` → .NET. Microsoft's C# mark is not in the set, and .NET is the platform it names.
 *   - `tsx`/`jsx` → React, which is what those extensions are for in this app.
 *   - `gitignore` → Git, because the file is Git's rather than a language's.
 *
 * And several are deliberately absent. `sql` is not MySQL's — SQL is a language a dozen engines
 * speak, and stamping one vendor on it would be telling the reader something untrue. `ini`,
 * `.env`, `diff`, Protocol Buffers, PowerShell and Objective-C have no mark here at all. All of
 * them fall back to the neutral glyph; see `LanguageIcon`.
 */
const MARKS = {
	ts: "TypeScript",
	tsx: "React",
	js: "JavaScript",
	jsx: "React",
	json: "JSON",
	jsonc: "JSON",
	md: "Markdown",
	css: "CSS",
	scss: "Sass",
	less: "Less",
	html: "HTML5",
	vue: "Vue.js",
	svelte: "Svelte",
	xml: "XML",
	py: "Python",
	go: "Go",
	rs: "Rust",
	java: "OpenJDK",
	kt: "Kotlin",
	c: "C",
	cpp: "C++",
	cs: ".NET",
	swift: "Swift",
	rb: "Ruby",
	php: "PHP",
	yaml: "YAML",
	toml: "TOML",
	sh: "GNU Bash",
	dockerfile: "Docker",
	nginx: "NGINX",
	graphql: "GraphQL",
	lua: "Lua",
	r: "R",
	jl: "Julia",
	scala: "Scala",
	hs: "Haskell",
	clj: "Clojure",
	ex: "Elixir",
	erl: "Erlang",
	dart: "Dart",
	groovy: "Apache Groovy",
	perl: "Perl",
	cmake: "CMake",
	tex: "LaTeX",
	gitignore: "Git",
};

const byTitle = new Map();
// Entries rather than a computed lookup: a namespace import is not an object to index into.
for (const [, icon] of Object.entries(icons)) {
	if (icon?.title) byTitle.set(icon.title.toLowerCase(), icon);
}

/**
 * A brand colour that survives a dark background.
 *
 * Several marks are black or near-black — Rust, JSON, Markdown, Lua — which is correct on the page
 * they were designed for and invisible on ours. Brightening them is a change to someone's mark, so
 * it is done as little as possible: only marks below the threshold move, and they move toward white
 * only far enough to be seen, keeping their hue.
 *
 * Perceptual luminance rather than the sRGB average, because #0000FF and #FFFF00 have the same
 * average and are nothing alike to look at.
 */
const luminance = (hex) => {
	const n = parseInt(hex, 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** Mixed toward white until it clears the floor, hue intact. */
const lift = (hex, floor) => {
	const n = parseInt(hex, 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	const now = luminance(hex);
	// How far toward white we have to go. `now` is below `floor` by construction.
	const t = Math.min(0.72, (floor - now) / (1 - now));
	const up = (c) => Math.round(c + (255 - c) * t);
	return [up(r), up(g), up(b)].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
};

/**
 * Below this a mark is genuinely lost against the app's dark surfaces; above it, leave it alone.
 *
 * 0.3 rather than something higher, because altering a trademark is not free and most marks do not
 * need it. TypeScript's blue sits at 0.42 and reads perfectly well on our darkest surface; a
 * threshold that caught it would be repainting two thirds of the set to fix four of them. What is
 * actually invisible is the black ones — Rust, JSON, Markdown, OpenJDK — plus Lua's navy at 0.06
 * and Less's slate at 0.20.
 */
const DARK_FLOOR = 0.3;

/** What a lifted mark is raised to: enough to read, not so much that it stops being the colour. */
const DARK_TARGET = 0.45;

const rows = [];
const missing = [];
for (const [key, title] of Object.entries(MARKS)) {
	const icon = byTitle.get(title.toLowerCase());
	if (!icon) {
		missing.push(`${key} (${title})`);
		continue;
	}
	const dim = luminance(icon.hex) < DARK_FLOOR;
	rows.push({
		key,
		title: icon.title,
		hex: icon.hex,
		// Only carried when the mark actually needs it, so the common case costs nothing.
		...(dim ? { dark: lift(icon.hex, DARK_TARGET) } : null),
		path: icon.path,
	});
}

if (missing.length > 0) {
	console.error(`这些标记在 simple-icons 里找不到，映射表需要更新：\n  ${missing.join("\n  ")}`);
	process.exit(1);
}

const bytes = rows.reduce((sum, row) => sum + row.path.length, 0);

const file = `/**
 * Language marks, extracted from \`simple-icons\` at build time.
 *
 * **Generated — do not edit.** Run \`node scripts/make-language-icons.mjs\` instead; the mapping
 * from our language keys to the marks, and the reasoning behind the substitutions, lives there.
 *
 * Held as path data rather than as components so the whole set is one small data module that can
 * be fetched when a language list is first opened and then cached — see \`LanguageIcon\`. Nothing
 * here reaches the first paint.
 *
 * ${rows.length} marks, ${(bytes / 1024).toFixed(1)}KB of path data.
 */

export interface LanguageMark {
	/** The mark's own name, which is not always the language's — see the generator. */
	title: string;
	/** Brand colour, without the leading hash. */
	hex: string;
	/**
	 * A lifted version for dark surfaces, present only for marks that need one.
	 *
	 * Rust, JSON, Markdown and Lua are black or near-black: correct on the page they were designed
	 * for, invisible on ours. Absent for every mark that reads fine as it is.
	 */
	dark?: string;
	/** SVG path data, on a 24×24 viewBox. */
	path: string;
}

export const LANGUAGE_MARKS: Record<string, LanguageMark> = {
${rows.map((row) => `\t${/^[a-z][a-z0-9]*$/.test(row.key) ? row.key : JSON.stringify(row.key)}: ${JSON.stringify(row.dark ? { title: row.title, hex: row.hex, dark: row.dark, path: row.path } : { title: row.title, hex: row.hex, path: row.path })},`).join("\n")}
};
`;

await writeFile(OUT, file);
const lifted = rows.filter((row) => row.dark);
console.log(`写出 ${rows.length} 个标记，路径数据 ${(bytes / 1024).toFixed(1)}KB → ${OUT}`);
console.log(`其中 ${lifted.length} 个在暗色下提亮：${lifted.map((row) => `${row.title} #${row.hex}→#${row.dark}`).join("、")}`);
