import { readFile, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolContext } from "../types.ts";
import { recordFileChange } from "./file-changes.ts";
import { openRepo, withRepoView, type HostGit, type HostRepo } from "./host-git.ts";

/*
 * 宿主进程里的 git 一律经 `host-git.ts`：仓库是沙箱可写的，直接 `execFile("git")` 会替沙箱执行
 * 它写进 `.git/config` 的 filter、fsmonitor、钩子。
 */
interface Snapshot { repo: HostRepo; files: Map<string, string | null> }
async function names(git: HostGit, head: string | null): Promise<string[]> {
	// `--no-renames` 等不是性能选项：改名检测要读 blob，外部 diff 与 textconv 会执行程序（视图里也没有，这里再关一次）。
	const [tracked, untracked] = await Promise.all([git(head ? ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", head, "--"] : ["ls-files", "--cached", "-z"]), git(["ls-files", "--others", "--exclude-standard", "-z"])]);
	return [...new Set((tracked + untracked).split("\0").filter(Boolean))];
}
async function content(path: string): Promise<string | null> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`无法记录大型文件或非普通文件：${path}`);
		const value = await readFile(path, "utf8");
		if (value.includes("\0")) throw new Error(`无法记录二进制文件：${path}`);
		return value;
	} catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}
export async function beforeCommand(ctx: ToolContext): Promise<Snapshot | null> {
	if (!ctx.scratchDir) return null;
	const repo = await openRepo(ctx.cwd);
	if (!repo) return null;
	const paths = await withRepoView(repo, (git) => names(git, repo.head));
	if (paths.length > 200) throw new Error("工作区已有超过 200 个改动文件，本次命令不自动记录文件差异");
	const files = new Map<string, string | null>();
	let bytes = 0;
	for (const path of paths) {
		const value = await content(join(repo.root, path)); bytes += value?.length ?? 0;
		if (bytes > 16 * 1024 * 1024) throw new Error("已有改动超过 16 MiB，本次命令不自动记录文件差异");
		files.set(path, value);
	}
	return { repo, files };
}
export async function afterCommand(ctx: ToolContext, before: Snapshot | null): Promise<string[]> {
	if (!before) return [];
	const { root, head } = before.repo;
	return withRepoView(before.repo, async (git) => {
		const paths = [...new Set([...await names(git, head), ...before.files.keys()])];
		if (paths.length > 200) throw new Error("命令影响超过 200 个文件，请在 Git 面板查看完整差异");
		const ids: string[] = [];
		for (const path of paths) {
			const absolute = join(root, path);
			const after = await content(absolute);
			let original = before.files.get(path);
			if (original === undefined) {
				/*
				 * `cat-file --filters`, not `show`: a blob is stored normalized and `show` returns it as stored
				 * — LF — while the file on disk went through the checkout's conversion (CRLF under
				 * `core.autocrlf` or `eol=crlf`). Every line differed, and a one-line change was recorded as
				 * the whole file rewritten. `--filters` (Git 2.11+) converts the way a checkout does.
				 * 在视图里跑，配置中没有任何 filter 驱动，所以它只做换行/ident/编码这些进程内转换，不执行 smudge。
				 */
				try { original = head ? await git(["cat-file", "--filters", `${head}:${relative(root, absolute).split("\\").join("/")}`]) : null; }
				catch { original = null; }
			}
			if (original === after) continue;
			const id = await recordFileChange(ctx, absolute, original, after, "command"); if (id) ids.push(id);
		}
		return ids;
	});
}
