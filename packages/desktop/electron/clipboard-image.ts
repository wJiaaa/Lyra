/**
 * 一张图进剪贴板，作为图片而不是一串字。
 *
 * Electron 44 把剪贴板改成了 W3C 那一套：`writeImage` 没了，写什么都是一个按 MIME 类型分键的
 * `ClipboardItem`，而且是异步的——调用处要 await，不然写失败落不进它外面那层 try。
 * 一律按 PNG 写：截图传进来的字节不一定是 PNG，经 `nativeImage` 转一道，粘出去的格式是确定的。
 */

import { clipboard, ClipboardItem, type NativeImage } from "electron";

export function writeClipboardImage(image: NativeImage): Promise<void> {
	return clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
}
