import { shell } from "electron";
import { isAbsolute, relative, resolve } from "node:path";
import { plumeHome, previewsHome } from "@plume/core";
import { nativeText } from "./i18n.ts";
import { localPageSource } from "./local-page.ts";
import { PREVIEW_SCHEME } from "./preview-protocol.ts";
import { openExternalSafely } from "./window-security.ts";

/** 预览地址在磁盘上的那份副本，和 `servePreview` 读的是同一个；出了预览目录的不算。 */
function previewCopy(url: URL): string | null {
	const root = previewsHome(plumeHome());
	const file = resolve(root, url.hostname, decodeURIComponent(url.pathname).replace(/^\//, ""));
	const inside = relative(root, file);
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? file : null;
}

/**
 * 一个标签的页面交给系统的浏览器，地址按先后试：页面此刻的地址，再是标签记着的那个。
 *
 * 地址由主进程从标签上取，渲染进程只给标签 id：`isOpenable` 不把 `file:` 交给系统，因为系统用默认程序打开
 * 那个路径，回答里的一个链接就成了本机执行。本地页面（`ly-preview:`）只开它来自的那个 `.html`——从地址栏
 * 或 agent 打开的原文件，找不到就开预览目录里那份副本；Plume 自己的地址系统浏览器不认识。
 */
export async function openOutside(addresses: string[]): Promise<void> {
	for (const raw of addresses) {
		if (openExternalSafely(raw)) return;
		let url: URL;
		try { url = new URL(raw); } catch { continue; }
		if (url.protocol !== `${PREVIEW_SCHEME}:`) continue;
		const file = localPageSource(raw) ?? previewCopy(url);
		if (!file || !/\.html?$/i.test(file)) continue;
		const failed = await shell.openPath(file);
		if (failed) throw new Error(failed);
		return;
	}
	throw new Error(nativeText("browser.nothingOutside"));
}
