import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { collectSkills, commandSources, loadCommands, lyraHome, type Settings } from "@lyra/core";

/** Resolve against a fresh inventory; the renderer cannot choose an arbitrary file or directory. */
export async function definitionTrashTarget(kind: unknown, cwd: unknown, path: unknown, settings: Settings): Promise<string> {
	if (typeof cwd !== "string" || typeof path !== "string" || !isAbsolute(path)) throw new Error("无效的定义文件路径。");
	let target: string | undefined;
	if (kind === "command") {
		const { commands } = await loadCommands(commandSources(cwd || null, lyraHome()));
		target = commands.find((command) => command.path === path)?.path;
	} else if (kind === "skill") {
		// Bundled skills are managed through plugin uninstall, never by removing part of a bundle.
		const { skills } = await collectSkills(cwd, [], settings);
		const skill = skills.find((skill) => skill.path === path && skill.source !== "builtin" && !skill.pluginId);
		target = skill?.dir;
	} else {
		throw new Error("不支持删除这种能力。");
	}
	if (!target) throw new Error("这项定义已不存在，或属于不能单独删除的内置、插件能力。请刷新列表。");
	const info = await lstat(target);
	// Trash the discovered symlink itself, so a shared definition's target is left intact.
	if (!info.isSymbolicLink() && (kind === "skill" ? !info.isDirectory() : !info.isFile())) {
		throw new Error("定义文件的类型已经变化，请刷新列表。");
	}
	return target;
}
