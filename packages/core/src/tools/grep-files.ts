/**
 * 没有 ripgrep 时，兜底扫描器该读哪些文件。
 *
 * ripgrep 默认不碰被 `.gitignore` 忽略的路径。兜底原先只认 `grep.ts` 里那张目录名单，于是被忽略
 * 却不在名单上的目录照样整个读一遍：本仓库 2.9G 的 `packages/mobile/ios`、本地笔记 `docs/plan`
 * 都在其中——全库搜一次 1.8 秒（ripgrep 46 毫秒），结果里还混着这些地方的命中。
 *
 * 所以在 git 仓库里就问 git 要清单；不在仓库里、或 git 答不上来，返回 null，由调用方退回目录名单。
 * 问 git 必须经 `host-git.ts`：仓库配置是沙箱可写的，直接跑 `ls-files` 读 index 会替它执行
 * `core.fsmonitor`。
 */

import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { openRepo, withRepoView } from "./host-git.ts";

/**
 * `root` 之下 git 认为该搜的文件（已跟踪的，加上未跟踪且没被忽略的），绝对路径。
 *
 * 隐藏目录照兜底原来的规矩跳过；隐藏文件（`.oxlintrc.json` 之类）照旧保留。
 */
export async function gitListedFiles(root: string): Promise<string[] | null> {
	// 比较前先取真实路径：git 报的仓库根是解析过软链的，`/var/…` 与 `/private/var/…` 会让 relative 出界。
	const real = await realpath(root).catch(() => null);
	if (!real) return null;
	const repo = await openRepo(real);
	if (!repo) return null;
	const inside = relative(repo.root, real);
	if (inside.startsWith("..")) return null;
	const pathspec = inside ? inside.split(sep).join("/") : ".";
	let listed: string;
	try {
		listed = await withRepoView(repo, (git) => git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]));
	} catch {
		return null;
	}
	const files: string[] = [];
	for (const path of new Set(listed.split("\0"))) {
		if (!path) continue;
		const full = join(repo.root, path);
		const dirs = relative(real, full).split(sep).slice(0, -1);
		if (dirs.some((name) => name.startsWith("."))) continue;
		files.push(full);
	}
	return files;
}
