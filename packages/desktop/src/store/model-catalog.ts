/**
 * 渲染进程的模型目录跟主进程对齐。
 *
 * 目录住在 core 的模块状态里，两个进程各有一份：主进程会从 pi 更新，渲染进程只有打包的快照。编辑器
 * 搜索、导入、用量页都在渲染进程查目录，所以要换上主进程那份。带上本地版本号去问，版本相同时主进程
 * 回 `null`，随时可以问一句而不必每次传整份目录。
 */

import { activeModelCatalog, installModelCatalog } from "@plume/core/model-catalog";
import { bridge } from "../services/index.ts";

/** 换上主进程的目录。返回当前版本号，拿不到（网页端没有这个方法）就还是本地那份。 */
export async function pullModelCatalog(): Promise<string> {
	try {
		const document = await bridge.providers.modelCatalog(activeModelCatalog().source.revision);
		if (document) installModelCatalog(document);
	} catch {
		// 打包的快照照样能用；主进程保存设置时还会再套一遍目录值。
	}
	return activeModelCatalog().source.revision;
}
