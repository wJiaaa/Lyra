import { shell } from "electron";
import { isAbsolute, relative, resolve } from "node:path";
import { plumeHome, previewsHome } from "@plume/core";
import { nativeText } from "./i18n.ts";
import { browserLocalPage } from "../shared/browser.ts";
import { localPagePath, localPageSource } from "./local-page.ts";
import { PREVIEW_SCHEME } from "./preview-protocol.ts";
import { openExternalSafely } from "./window-security.ts";

/** 预览地址在磁盘上的那份副本，和 `servePreview` 读的是同一个；出了预览目录的不算。 */
function previewCopy(url: URL): string | null {
	const root = previewsHome(plumeHome());
	const file = resolve(root, url.hostname, decodeURIComponent(url.pathname).replace(/^\//, ""));
	const inside = relative(root, file);
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? file : null;
}

function previewSource(address: string): string | null {
	let url: URL;
	try { url = new URL(address); } catch { return null; }
	return url.protocol === `${PREVIEW_SCHEME}:` ? localPageSource(address) ?? previewCopy(url) : null;
}

/**
 * 交给系统的浏览器，地址按先后试：标签的是页面此刻的地址、再是标签记着的那个；地址栏的是打了还没回车的那一行。
 *
 * `isOpenable` 不把 `file:` 交给系统，因为系统用默认程序打开那个路径，回答里的一个链接就成了本机执行。
 * 本地的只开 `.html`：打出来的路径、或本地页面（`ly-preview:`）来自的原文件，找不到原文件就开预览目录里
 * 那份副本；Plume 自己的地址系统浏览器不认识。
 */
export async function openOutside(addresses: string[]): Promise<void> {
	for (const raw of addresses) {
		if (openExternalSafely(raw)) return;
		const file = browserLocalPage(raw) ? localPagePath(raw) : previewSource(raw);
		if (!file || !/\.html?$/i.test(file)) continue;
		const failed = await shell.openPath(file);
		if (failed) throw new Error(failed);
		return;
	}
	throw new Error(nativeText("browser.nothingOutside"));
}
