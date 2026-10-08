/**
 * 两个会话能不能互相通信：它们的目录有没有重叠。
 *
 * 一个会话的目录是它的 cwd、它所在项目的全部源目录（一个项目可以是好几个文件夹），再加上：
 * cwd 是 git worktree 时，它的主工作树。最后这一条是因为 worktree 默认建在 `~/.plume/worktrees`，
 * 不在项目目录里——不认它的话，「几个 worktree 并行干活、干完交接」这件最常见的事恰好做不了。
 *
 * 比较前一律过 `pathKey`：`/var` 与 `/private/var`、软链、Windows 的大小写和分隔符，都是同一个
 * 目录的不同写法。包含判断用 core 的 `pathWithin`，`p-old` 不算在 `p` 里。
 */

import { dirname } from "node:path";
import { pathWithin, projectRootsFor, type ProjectEntry } from "@plume/core";
import { git } from "./git-exec.ts";
import { pathKey } from "./path-key.ts";

/** 会话的 cwd 在它活着的时候不变，主工作树也就不变；git 只问一次。 */
const mainTrees = new Map<string, Promise<string | null>>();

/** cwd 是一个链出去的 worktree 时，主工作树在哪；不是就是 null。 */
function mainWorktree(cwd: string): Promise<string | null> {
	let pending = mainTrees.get(cwd);
	if (!pending) {
		pending = (async () => {
			try {
				const [gitDir, commonDir] = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).trim().split(/\r?\n/);
				if (!gitDir || !commonDir || pathKey(gitDir) === pathKey(commonDir)) return null;
				return dirname(commonDir);
			} catch {
				return null;
			}
		})();
		mainTrees.set(cwd, pending);
	}
	return pending;
}

export async function sessionRoots(cwd: string, projects: readonly Pick<ProjectEntry, "path" | "folders">[] | undefined): Promise<string[]> {
	const main = await mainWorktree(cwd);
	const roots = [cwd, ...projectRootsFor(projects, cwd), ...(main ? [main, ...projectRootsFor(projects, main)] : [])];
	return Array.from(new Set(roots.map(pathKey)));
}

/** 两组目录里有没有一对是同一个、或一个包含另一个。两边都要先过 `pathKey`。 */
export function rootsOverlap(a: readonly string[], b: readonly string[]): boolean {
	return a.some((x) => b.some((y) => pathWithin(x, y) || pathWithin(y, x)));
}
