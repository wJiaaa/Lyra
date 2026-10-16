/**
 * electron-builder 的 `beforePack`：在复制 `extraResources` 之前，备好正在打的平台要带的二进制。
 *
 * 只能挂一个脚本，所以两件事在这里排队：ripgrep 每个平台、每个架构各一份（`fetch-ripgrep.mjs`），
 * macOS 再加上截图用的取屏小程序（`build-screen-capture.mjs`，通用二进制，两个架构共用一份）。
 * 任何一步失败都让打包失败——缺了它们的安装包能装能用，只是悄悄退回了慢的或不对的那条路。
 */

import { buildScreenCapture } from "./build-screen-capture.mjs";
import { beforePack as fetchRipgrepForBuild } from "./fetch-ripgrep.mjs";

export function beforePack(context) {
	fetchRipgrepForBuild(context);
	if (context.electronPlatformName === "darwin") buildScreenCapture();
}
