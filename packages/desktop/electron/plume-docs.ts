/**
 * 告诉 core 的 `plume://` 使用说明在哪。
 *
 * core 默认从自己源码旁边的 `plume-docs/` 读，但桌面端把 core 打进了 `out/main` 的一个文件里，
 * 那个相对位置开发时和打包后都不存在。打包后由 `electron-builder.yml` 的 `extraResources` 放到
 * `resources/plume-docs/`，开发时直接指回源码目录。
 *
 * 写进环境变量而不是传参：子代理跑在主进程派生的子进程里，环境会跟过去。
 */

import { join } from "node:path";

export interface DocsLocation {
	packaged: boolean;
	/** `app.getAppPath()`：开发时是 `packages/desktop`。 */
	appPath: string;
	/** `process.resourcesPath`。 */
	resourcesPath: string;
}

export function bundledDocs(where: DocsLocation): string {
	return where.packaged
		? join(where.resourcesPath, "plume-docs")
		: join(where.appPath, "..", "core", "src", "resources", "plume-docs");
}

export function useBundledDocs(where: DocsLocation): void {
	process.env.PLUME_DOCS = bundledDocs(where);
}
