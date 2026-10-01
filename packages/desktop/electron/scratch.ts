/**
 * Where a conversation happens when it happens in no project.
 *
 * A session needs a working directory, and sometimes there is honestly no right answer for one. A
 * review is of someone else's branch in a repository this machine may never have cloned; 「不在项目
 * 中工作」 is the user saying so outright. Pointing the agent at whichever project happened to be
 * open would hand it a working tree with nothing to do with the question.
 *
 * So those sessions get a scratch directory under the app's home instead. Nothing is expected to
 * be in it. It is somewhere to put a patch, a note, a checkout if the conversation goes that way —
 * and, for a pull request, it is also a stable identity: sessions are stored by a hash of their
 * directory, so the same review comes back to the same conversation months later without anything
 * being recorded on the side.
 *
 * The path is derived, never taken from the API. A repository name arrives from GitHub as
 * `owner/name` and could in principle carry anything else; this is a filesystem path being built
 * from remote input, so every character outside a safe set is replaced rather than trusted.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plumeHome, within } from "@plume/core";

/** Everything outside this becomes a dash, which also flattens `owner/name` into one segment. */
const UNSAFE = /[^a-zA-Z0-9._-]+/g;

/**
 * A short, stable, unambiguous folder name for one pull request.
 *
 * Bounded because a repository name has no length limit worth relying on and a path component
 * does. Truncation could in principle collide, which is why the number is appended after it: two
 * repositories that truncate alike still differ by their pull request number in almost every case,
 * and the worst outcome — two reviews sharing one scratch directory — costs a mixed transcript,
 * not data.
 */
export function prChatSlug(repo: string, number: number): string {
	const safe =
		repo
			/*
			 * Runs of dots collapse before anything else.
			 *
			 * A dot has to stay in the safe set — plenty of repositories are named `something.js` —
			 * but that also lets `..` through, and replacing the separators around it leaves a
			 * `..` segment sitting in a path built from remote input. It cannot traverse anything
			 * as this is used today, since it ends up as one component of a path we join ourselves.
			 * It is removed anyway: the next person to reuse this for a nested path should not have
			 * to notice that it was only safe by circumstance.
			 */
			.replace(/\.{2,}/g, ".")
			.replace(UNSAFE, "-")
			// Leading dots hide the directory; leading or trailing dashes are just noise.
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 60) || "repo";
	return `${safe}-${number}`;
}

/**
 * The directory every project-less conversation runs in.
 *
 * Exposed so the renderer can recognise these sessions and keep them out of the sidebar's project
 * list. They are real sessions in a real directory — that is what makes them reopen months later —
 * but they are not projects, and listing a folder called `owner-repo-6381` between someone's actual
 * work is noise. Derived here rather than pattern-matched there: the home is `PLUME_HOME`-overridable,
 * so a hard-coded path in the renderer would be wrong for anyone who moved it.
 *
 * `workspaces/`, and the name is the fix.
 *
 * This used to be `scratch/` — the same directory `core` uses for the throwaway files it tells the
 * model to write, which are named after the session that made them and swept on every launch by
 * `pruneSessionArtifacts`: any subdirectory whose name is not a live session id is deleted. Nothing
 * here is named after a session. `general` and `owner-repo-6381` were never live session ids, so
 * every launch deleted the working directory of every project-less conversation and every pull
 * request review — the checkout, the patch, the PR.md written for it, all of it — and the next
 * launch deleted whatever had been put there since.
 *
 * Two mechanisms, one path, opposite lifetimes. Separating them is the whole repair: `core` keeps
 * sweeping `scratch/`, and nothing it sweeps belongs to anybody.
 */
function workspacesRoot(): string {
	return join(plumeHome(), "workspaces");
}

/**
 * The directories the window treats as the app's own working space rather than a project.
 *
 * `workspaces/` is where project-less conversations run. `scratch/` is `core`'s: the throwaway
 * files it tells the model to write live there, and a chat that shows or links one of them has to be
 * able to open it — so it is readable through the same gate, even though no session runs in it.
 */
export function scratchRoots(): string[] {
	return [workspacesRoot(), join(plumeHome(), "scratch")];
}

/** The working directory for one pull request, created if it is not there yet. */
export async function prScratchDir(repo: string, number: number): Promise<string> {
	const dir = join(workspacesRoot(), prChatSlug(repo, number));
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * The working directory for a conversation with no subject at all — 「不在项目中工作」.
 *
 * One shared directory rather than one per session: without a pull request there is nothing to
 * derive a stable name from, and a fresh folder per conversation would pile up empty directories
 * nobody ever looks in.
 */
export async function generalScratchDir(): Promise<string> {
	const dir = join(workspacesRoot(), "general");
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Put a project-less conversation's directory back if it is missing, and refuse anything else.
 *
 * A directory under the app's own home is something a person can delete without thinking of it as
 * deleting a conversation. The session is still in the log and still opens — it just has nowhere to
 * run, and every tool in it fails on a working directory that is not there.
 *
 * Guarded by the roots rather than trusting the caller: this creates directories from a path that
 * came out of a stored session record, and the one thing it must never do is create one somewhere
 * that is not ours.
 */
export async function ensureSessionWorkspace(cwd: string): Promise<boolean> {
	// `within`, not a hand-built prefix: appending "/" and comparing is correct on Unix and false
	// for every input on Windows, which would have turned this guard into a blanket refusal there.
	if (!scratchRoots().some((root) => within(root, cwd))) return false;
	await mkdir(cwd, { recursive: true });
	return true;
}

export interface PrBrief {
	repo: string;
	number: number;
	title: string;
	author: string;
	url: string;
	headRefName: string;
	baseRefName: string;
	state: string;
	body: string;
}

/**
 * Leave the facts of the pull request in the directory the conversation runs in.
 *
 * The alternative was pasting all of it into the first question, which puts the description of
 * somebody else's change above what the user actually asked and spends the same tokens on every
 * new conversation. A file is there when wanted and costs nothing when not — and it is the
 * obvious thing for an agent to find in an otherwise empty working directory.
 *
 * Deliberately not the diff. Those run to megabytes, they are the part most likely to be stale by
 * the time anyone reads it, and `gh pr diff` fetches the current one on demand.
 */
export async function writePrBrief(dir: string, pr: PrBrief): Promise<void> {
	const lines = [
		`# ${pr.title}`,
		"",
		`- 仓库：${pr.repo}`,
		`- 编号：#${pr.number}`,
		`- 作者：${pr.author}`,
		`- 分支：${pr.headRefName} → ${pr.baseRefName}`,
		`- 状态：${pr.state}`,
		`- 链接：${pr.url}`,
		"",
		"拿到改动：",
		"",
		"```sh",
		`gh pr diff ${pr.number} --repo ${pr.repo}`,
		"```",
		"",
		"## 描述",
		"",
		pr.body.trim() || "（作者没有写描述）",
		"",
	];
	await writeFile(join(dir, "PR.md"), lines.join("\n"), "utf8");
}
