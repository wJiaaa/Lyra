/**
 * What a local file link should show in the transcript.
 *
 * Models write [`docs/issue/very-long-name.md`](docs/issue/very-long-name.md). Painting that whole
 * path inside a chip forces a wrap through the middle of a word. The chip keeps the filename;
 * overflow is an ellipsis, never a second line. The path belongs on the tooltip.
 */
export function fileLinkCaption(label: string, path: string): { text: string; tip: string } {
	const trimmed = label.trim().replace(/:\d+(?:-\d+)?$/, "");
	const base = path.split(/[/\\]/).pop()?.trim() || path;
	if (!trimmed) return { text: base, tip: path };
	const pathLike = /[/\\]/.test(trimmed) || trimmed === base;
	if (!pathLike) return { text: trimmed, tip: path };
	return { text: trimmed.split(/[/\\]/).pop() || base, tip: trimmed };
}

/**
 * 裸文件名只认这些扩展名。带目录的路径不查这张表。
 *
 * `console.log`、`process.env`、`obj.method` 在形状上和 `index.ts` 一样，全靠扩展名分辨；
 * 表里只放一眼就是文件的那些，漏掉的冷门类型写成带目录的路径照样能点。
 */
const BARE_FILE_EXTENSIONS = new Set(
	"ts tsx mts cts js jsx mjs cjs json jsonc md mdx yaml yml toml ini xml csv sql html htm css scss sass less vue svelte py rs go java kt rb php swift c h cpp hpp cs sh bash zsh ps1 bat lock txt png jpg jpeg gif svg webp pdf".split(" "),
);

/**
 * 行内代码里写的是不是一个文件路径；是的话返回它（保留 `:42` 行号后缀）。
 *
 * 提示词让模型把路径写成 `path/to/file.ts:42` 以便点击，所以这类行内代码要画成文件链接。
 * 判断宁紧勿松：带空格、括号、引号、协议的都不是；目录（以分隔符结尾）不是；最后一段必须有
 * 以字母开头的扩展名，这样 `feature/v1.2`、`origin/main`、`node:test` 都留作代码。
 */
export function filePathInCode(text: string): string | null {
	const raw = text.trim();
	if (!raw || raw.length > 300 || /[\s()[\]{}<>"'`,;=*?|$&!]/.test(raw) || raw.includes("://")) return null;
	const path = raw.replace(/:\d+(?:-\d+)?$/, "");
	if (/[/\\]$/.test(path)) return null;
	const base = path.split(/[/\\]/).pop() ?? "";
	const ext = /^[\w@+-][\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(base)?.[1];
	if (!ext) return null;
	const pathLike = /[/\\]/.test(path);
	if (!pathLike && !BARE_FILE_EXTENSIONS.has(ext.toLowerCase())) return null;
	return raw;
}
