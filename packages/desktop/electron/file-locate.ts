/**
 * 回复里写的一条相对路径，在项目里实际指的是哪个文件。
 *
 * 模型常把文件写成 `approvals.ts:125`、`scripts/check-native-arch.mjs`——前者只有名字，后者相对的是
 * 某个子包而不是工作目录。按工作目录直接拼，点开的是项目根下一个不存在的文件。这里先按原样找，
 * 找不到再在项目的文件里按结尾匹配，由调用方决定只有一个匹配时才认。
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { git } from "./git-exec.ts";

/** 同名文件再多也只列这么几个：调用方只认唯一的那一个，多出来的数目没有用处。 */
const LIMIT = 8;

/**
 * 返回相对 `root` 的路径，由调用方拼回它自己认的那个项目目录。`root` 是过了边界检查、解析过软链的
 * 真实目录；直接拼它，项目在软链下时（`/var` 与 `/private/var`）文件面板就认不出这是项目里的文件。
 */
export async function locateInProject(root: string, relative: string): Promise<string[]> {
	const clean = relative.replaceAll("\\", "/").replace(/^\.\//, "");
	// 通配符会被 pathspec 当成模式；`..` 会走出项目。两种都不是「回复里提到的一个文件」。
	if (!clean || isAbsolute(clean) || /[*?[\]]/.test(clean) || clean.split("/").includes("..")) return [];

	if ((await stat(join(root, clean)).catch(() => null))?.isFile()) return [clean];

	/*
	 * 交给 git 列：它认 .gitignore，`node_modules` 和构建产物里的同名文件不会混进来。不是 git 仓库的
	 * 项目这里拿不到结果，链接照旧按工作目录解析——要支持再补一个跳过忽略目录的遍历。
	 */
	const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob)**/${clean}`]).catch(() => "");
	return [...new Set(listed.split("\0").filter(Boolean))].slice(0, LIMIT);
}
