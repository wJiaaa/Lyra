/**
 * Serving the desktop's own interface to a browser.
 *
 * The browser does not get a copy of the UI built for it — it loads this one, the files the window
 * itself is running. Which means the two are the same build by construction: update the desktop
 * and the browser has the new interface on its next load.
 *
 * Same origin as the socket, and that is not incidental. The renderer's CSP is `connect-src 'self'`;
 * served from here, "self" *is* this server, so its WebSocket is allowed without loosening anything.
 *
 * In development the window loads from Vite and nothing writes these files until `pnpm build` has
 * run; the page says so rather than showing an empty 404.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

/** Where `electron-vite` puts the renderer, relative to the main process bundle. */
const ROOT = resolve(import.meta.dirname, "..", "renderer");

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".map": "application/json; charset=utf-8",
};

/**
 * The file a request path names, or the app's entry page when it names none.
 *
 * Anything that resolves outside the renderer directory is refused rather than clamped: `..` in a
 * request is never a legitimate way to reach one of these files.
 */
async function appFile(root: string, pathname: string): Promise<string | null> {
	let relative: string;
	try {
		relative = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
	} catch {
		return null;
	}
	const candidate = resolve(root, normalize(relative));
	if (candidate !== root && !candidate.startsWith(root + sep)) return null;

	for (const file of [candidate, join(candidate, "index.html")]) {
		try {
			if ((await stat(file)).isFile()) return file;
		} catch {}
	}
	// A path with an extension that is not there is a missing asset, not a page of the app.
	if (extname(relative)) return null;
	const entry = join(root, "index.html");
	try {
		return (await stat(entry)).isFile() ? entry : null;
	} catch {
		return null;
	}
}

/** Answer a request for the app. False when there is nothing to answer it with. */
export async function serveApp(
	pathname: string,
	res: ServerResponse,
	headers: Record<string, string>,
	root: string = ROOT,
): Promise<boolean> {
	const file = await appFile(root, pathname);
	if (!file) {
		if (extname(pathname)) return false;
		res.writeHead(503, { ...headers, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		res.end("The interface has not been built yet: run `pnpm build`, then reload.");
		return true;
	}
	res.writeHead(200, {
		...headers,
		"content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
		// The entry page names the current hashed bundles and must be fetched fresh; the bundles
		// themselves are named by their content and never change under the same name.
		"cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
	});
	createReadStream(file).pipe(res);
	return true;
}
