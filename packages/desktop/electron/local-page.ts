/**
 * Opening an HTML file from this disk in the browser panel, without a server.
 *
 * The page is copied into the previews directory and opened from `ly-preview://`, which the app
 * serves itself — see `readLocalPage` in core for why a copy, and why not the file where it lies.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plumeHome, readLocalPage, writePreview } from "@plume/core";
import { PREVIEW_SCHEME } from "./preview-protocol.ts";

/*
 * A tab with no conversation still needs a directory. Not a session id, so the startup prune
 * (`pruneSessionArtifacts`) clears it on the next launch — the same lifetime such a tab has.
 */
const UNOWNED = "browser";

/** `file://…`, `~/…` or an absolute path, as the absolute path. */
export function localPagePath(raw: string): string {
	const text = raw.trim();
	if (/^~[\\/]/.test(text)) return join(homedir(), text.slice(2));
	return /^file:/i.test(text) ? fileURLToPath(text) : text;
}

/**
 * Copy an already-read page and return the address that shows it.
 *
 * One copy per file, written over each time it is opened: the address stays the same, so opening the
 * file again after changing it is a reload of the same page, and the conversation knows the two opens
 * for one page (`pageOf` in `BrowserCard`). A fresh id each time left an agent that checked its page
 * after every edit with six addresses for one file, and six cards.
 */
/**
 * Which file each copy came from, by its address: opening the page in another browser opens the file,
 * since `ly-preview:` means nothing outside Plume. Gone with the process, like the tabs that need it.
 */
const sources = new Map<string, string>();
const copyKey = (raw: string): string => { try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return raw; } };
export function localPageSource(address: string): string | undefined { return sources.get(copyKey(address)); }

export async function localPageUrl(content: string, absolute: string, sessionId: string | null): Promise<string> {
	// One file by two spellings is still one copy: the address bar hands over `/private/var/…` where
	// `read`'s judgement hands back the workspace's `/var/…`, and a symlink is a third.
	const real = await realpath(absolute).catch(() => absolute);
	const record = await writePreview(plumeHome(), {
		id: `file-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`,
		sessionId: sessionId ?? UNOWNED,
		title: basename(absolute),
		files: [{ path: "index.html", content }],
		entry: "index.html",
	});
	const address = `${PREVIEW_SCHEME}://${record.sessionId}/${record.id}/${record.entry}`;
	sources.set(copyKey(address), real);
	return address;
}

/** The address bar and links: someone typed or clicked this path, so it is theirs to read. */
export async function openLocalPage(raw: string, sessionId: string | null): Promise<string> {
	const path = localPagePath(raw);
	return localPageUrl(await readLocalPage(path), path, sessionId);
}
