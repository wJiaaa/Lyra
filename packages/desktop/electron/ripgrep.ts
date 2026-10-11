/**
 * 把随包带的 ripgrep 交给 core 的 `grep` 工具。
 *
 * core 读 `PLUME_RIPGREP`，没有就去 `PATH` 里找 `rg`。从图标启动的应用 `PATH` 里只有系统目录，
 * 用户装了 `rg` 也找不到，于是每一次搜索都退回逐文件的 JavaScript 扫描。安装包里那份由
 * `scripts/fetch-ripgrep.mjs` 放进 `vendor/ripgrep/`，再经 `electron-builder.yml` 的
 * `extraResources` 落到 `resources/ripgrep/`。
 *
 * 写进环境变量而不是传参：工具也跑在主进程派生的子进程里（子代理、沙箱 runner），环境会跟过去。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RipgrepLocation {
	platform: string;
	arch: string;
	packaged: boolean;
	/** `app.getAppPath()`：开发时是 `packages/desktop`。 */
	appPath: string;
	/** `process.resourcesPath`。 */
	resourcesPath: string;
}

export function bundledRipgrep(where: RipgrepLocation): string {
	const exe = where.platform === "win32" ? "rg.exe" : "rg";
	// 打包后正是 `extraResources` 的 `to: ripgrep`；开发时是 fetch-ripgrep.mjs 放的位置。
	return where.packaged
		? join(where.resourcesPath, "ripgrep", exe)
		: join(where.appPath, "vendor", "ripgrep", `${where.platform}-${where.arch}`, exe);
}

/** 用户自己设了 `PLUME_RIPGREP` 就听用户的；随包那份不存在（开发时没下载）就不设，core 照旧找 `PATH`。 */
export function useBundledRipgrep(where: RipgrepLocation): void {
	if (process.env.PLUME_RIPGREP?.trim()) return;
	const path = bundledRipgrep(where);
	if (existsSync(path)) process.env.PLUME_RIPGREP = path;
}
