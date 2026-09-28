import type { ProjectEntry } from "@plume/core";
import { useApp } from "../../store/index.ts";

/**
 * 设置 › 插件选中的项目，null 是全局——见 `pluginsProject`。
 *
 * 从项目列表里查，而不是只信那条路径：项目被移除后，页面应当回到全局，而不是继续读一个已经
 * 不在列表里的目录。返回的是列表里的那一项本身，引用稳定，放进依赖里不会每次渲染都重跑。
 */
export function usePluginsProject(): ProjectEntry | null {
	return useApp((s) => (s.pluginsProject ? (s.settings?.projects.find((project) => project.path === s.pluginsProject) ?? null) : null));
}
