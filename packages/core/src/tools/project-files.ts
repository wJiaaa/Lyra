/**
 * 项目里该看哪些文件：grep 兜底、`glob`、symbol 索引共用这一份清单。
 *
 * ripgrep 默认不碰被 `.gitignore` 忽略的路径。兜底原先只认 `grep.ts` 里那张目录名单，于是被忽略
 * 却不在名单上的目录照样整个读一遍：本仓库 2.9G 的 `packages/mobile/ios`、本地笔记 `docs/plan`
 * 都在其中——全库搜一次 1.8 秒（ripgrep 46 毫秒），结果里还混着这些地方的命中。名单反过来也会错：
 * 提交进仓库、只是恰好叫 `build/` 的目录被整个跳过，搜 plist 的 `glob` 漏掉了本仓库唯一一个
 * 真正的 plist，返回的却全是 `release/` 里打包产物的。
 *
 * 隐藏的也算：`.github/workflows/package.yml` 是提交进仓库的文件，搜一个只在那里出现的变量名却搜不到，
 * 等于告诉模型它不存在。要跳过的隐藏目录（`.venv`、`.idea`）本来就在 `.gitignore` 里。
 *
 * 所以在 git 仓库里就问 git 要清单；不在仓库里、或 git 答不上来，返回 null，由调用方退回目录名单。
 * 问 git 必须经 `host-git.ts`：仓库配置是沙箱可写的，直接跑 `ls-files` 读 index 会替它执行
 * `core.fsmonitor`。
 */

import { realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { openRepo, withRepoView } from "./host-git.ts";

/**
 * `root` 之下 git 认为该看的文件（已跟踪且还在磁盘上的，加上未跟踪且没被忽略的），绝对路径，
 * 以调用方给的 `root` 开头。
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
	let deleted: Set<string>;
	try {
		[listed, deleted] = await withRepoView(repo, async (git) => [
			await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]),
			// `--cached` 照 index 列，工作区里删掉还没提交的也在里面；`glob` 会把它们当成存在的文件报出来。
			new Set((await git(["ls-files", "-z", "--deleted", "--", pathspec])).split("\0")),
		]);
	} catch {
		return null;
	}
	const files: string[] = [];
	for (const path of new Set(listed.split("\0"))) {
		// 以 `/` 结尾的是 `--others` 报的嵌套仓库，整个目录一条，不是文件。
		if (!path || path.endsWith("/") || deleted.has(path)) continue;
		// 拼回调用方的 `root` 而不是真实路径：软链下的项目，调用方按 `root` 求相对路径，拿到的是 `../../private/…`。
		files.push(join(root, relative(real, join(repo.root, path))));
	}
	return files;
}

/**
 * `root` 是否在某个 git 工作区里，只看路径上有没有 `.git`，不起进程。
 *
 * ripgrep 认 `.gitignore` 也是这样判断的。给它的 `--hidden` 只在这时加：仓库外没有忽略规则兜着，
 * 从家目录搜会一头扎进 `~/.cache`、`~/.npm`。
 */
export async function insideGitWorkTree(root: string): Promise<boolean> {
	for (let dir = root; ; dir = dirname(dir)) {
		if (await stat(join(dir, ".git")).then(() => true, () => false)) return true;
		if (dirname(dir) === dir) return false;
	}
}
