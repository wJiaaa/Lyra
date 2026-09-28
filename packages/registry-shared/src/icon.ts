/**
 * Where a bundle's own icon lives, and which bytes we are willing to call one.
 *
 * The rules, with no IO: the platform applies them to tar members it just built, the app applies
 * them to a directory it just installed, and both have to reach the same answer. That is the same
 * invariant `inspectBundle` and the build's `inspect.ts` share — what the catalogue says a bundle
 * is, the app has to agree with once it is on disk — and an icon is one of those facts now, since
 * it arrives in the archive rather than being chosen by a maintainer afterwards.
 *
 * Two copies of a rule are two rules, with the one nobody compiles doing the drifting; the reason
 * these live here is that this package is compiled by both.
 */

/** Same ceiling the console enforces on uploads. An icon past this is a mistake or an attempt. */
export const MAX_ICON_BYTES = 1024 * 1024;

/**
 * Where to look, in order, when the manifest names nothing.
 *
 * Our own directory first: a repository carrying both `.lyra-plugin/icon.png` and a root `logo.png`
 * is one where the author put a picture *for us* in the place that says so. `assets/` is last
 * because it is where a project keeps every image, and the first one alphabetically is not
 * necessarily its mark.
 */
const DIRECTORIES = [".lyra-plugin/", ".claude-plugin/", ".codex-plugin/", "", "assets/"];
const STEMS = ["icon", "logo"];
/** Vector first — it is the one that stays sharp at every size a client draws it. */
const EXTENSIONS = ["svg", "png", "webp", "jpg", "jpeg", "gif"] as const;

const CONTENT_TYPES: Record<string, string> = {
	svg: "image/svg+xml",
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
};

/**
 * The paths to try, in order, for a bundle whose manifest declared `declared`.
 *
 * A relative path names one file and only that file. Falling through to a guessed one would serve a
 * different picture than the one asked for — a manifest that names an icon and gets it wrong is not
 * the same situation as one that names none, and an empty list is the answer to the first.
 *
 * A remote URL is not a claim about the archive at all: it is answered by fetching it, elsewhere. So
 * it does not narrow this search, and a bundle carrying both a `logo` URL and its own `icon.svg`
 * still offers the file.
 */
export function iconCandidates(declared?: string): string[] {
	if (declared && !/^https?:\/\//i.test(declared)) {
		const path = insidePath(declared);
		return path === null ? [] : [path];
	}

	const paths: string[] = [];
	for (const directory of DIRECTORIES) {
		for (const stem of STEMS) {
			for (const extension of EXTENSIONS) paths.push(`${directory}${stem}.${extension}`);
		}
	}
	return paths;
}

/**
 * The content type for a candidate, if its bytes are actually the picture its name claims.
 *
 * Returns null rather than throwing: a bad icon costs the icon, never the build and never the
 * install. An author whose plugin failed to publish because a stray `logo.png` was truncated would
 * have no way to tell what happened, and the plugin itself is fine.
 *
 * The extension is the only type information a tar member or a bare file carries, and it is chosen
 * by whoever wrote it. Serving `icon.png` as `image/png` when it holds markup is how a repository
 * nobody reviewed gets to put a document on someone's origin.
 */
export function acceptIcon(path: string, data: Uint8Array): { contentType: string } | null {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const contentType = CONTENT_TYPES[extension];
	if (!contentType) return null;
	if (data.length === 0 || data.length > MAX_ICON_BYTES) return null;
	if (!looksLike(extension, data)) return null;
	if (extension === "svg" && !isSafeSvg(data)) return null;
	return { contentType };
}

function looksLike(extension: string, data: Uint8Array): boolean {
	switch (extension) {
		case "png":
			return starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "jpg":
		case "jpeg":
			return starts(data, [0xff, 0xd8, 0xff]);
		case "gif":
			return starts(data, [0x47, 0x49, 0x46, 0x38]);
		case "webp":
			// RIFF container with a WEBP fourcc at offset 8; the four bytes between are the length.
			return starts(data, [0x52, 0x49, 0x46, 0x46]) && starts(data.subarray(8), [0x57, 0x45, 0x42, 0x50]);
		case "svg":
			return isSvgText(data);
		default:
			return false;
	}
}

function starts(data: Uint8Array, magic: number[]): boolean {
	if (data.length < magic.length) return false;
	return magic.every((byte, index) => data[index] === byte);
}

/** SVG has no magic number, so the test is that it parses as text and opens like a document. */
function isSvgText(data: Uint8Array): boolean {
	// Enough to reach the root element past a BOM, an XML declaration and a licence comment.
	const head = decode(data.subarray(0, 2048)).trimStart().replace(/^﻿/, "");
	return /^<(\?xml|!--|!DOCTYPE|svg)[\s>]/i.test(head.trimStart());
}

/**
 * Whether an SVG is one we will draw.
 *
 * Refused rather than sanitised, deliberately. Sanitising means keeping a list of everything
 * dangerous and being right about all of it forever; every such list has been escaped from. An
 * author whose icon is rejected can remove the script and commit again, which is a cost paid once
 * by one person — the other way round, the cost is paid by every viewer.
 *
 * It matters on both sides for different reasons. On the platform the file is served from its own
 * origin, so a script in it runs with the site's session cookie in scope. In the app it becomes a
 * `data:` URL in a renderer that can reach `window.plume` — a bundle anybody may publish must not be
 * able to put script there.
 */
function isSafeSvg(data: Uint8Array): boolean {
	const text = decode(data);
	const dangerous = [
		/<\s*script/i,
		/<\s*foreignObject/i,
		/<\s*iframe/i,
		/<\s*embed/i,
		/<\s*object/i,
		/<\s*(annotation-xml|use)[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i,
		// Any inline handler. `on` followed by letters and an equals sign is the whole family.
		/\son[a-z]+\s*=/i,
		/javascript\s*:/i,
		// External fetches: a tracking pixel in an icon is still a tracking pixel.
		/<\s*image[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i,
		/url\s*\(\s*["']?\s*(https?:)?\/\//i,
	];
	return !dangerous.some((pattern) => pattern.test(text));
}

/**
 * A manifest-relative path that stays inside the bundle, or null.
 *
 * The same rule the build applies to `skills` and `mcpServers`. It matters more here than it looks:
 * on the platform a climbing path finds nothing in a Map, but the app resolves it against a real
 * directory, where `../../../.ssh/id_rsa` is a file that exists and would be read and inlined into
 * a page as a picture.
 */
function insidePath(relative: string): string | null {
	const cleaned = relative.replace(/^\.\//, "").replace(/^\/+/, "").trim();
	if (!cleaned) return null;
	const parts = cleaned.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
	return cleaned;
}

function decode(data: Uint8Array): string {
	return new TextDecoder().decode(data);
}

/**
 * The manifest's `logo` when it is a URL, and nothing otherwise.
 *
 * The same field serves two purposes — a remote address, or a path to a file in the bundle — and
 * only one of them is something to fetch. A relative path treated as a URL is a request that 404s,
 * once per viewer.
 */
export function remoteLogo(declared: string | undefined): string | undefined {
	return declared && /^https:\/\//i.test(declared) ? declared : undefined;
}
