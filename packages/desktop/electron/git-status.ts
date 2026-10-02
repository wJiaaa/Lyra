/**
 * The index and the working tree, as two lists.
 *
 * The split is the whole reason to have an index in front of you: what the next commit will contain
 * and what it will not. Everything here reports or moves files between those two lists.
 */

import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { WorkspaceDiffFile } from "./ipc-types.ts";
import { git, run, mapLimit, MAX_BLOB_BYTES, MAX_FILES } from "./git-exec.ts";
import { classify } from "./git-diff.ts";
import { classifyRemote, type GitOperation, type RemoteState } from "./git-remote-state.ts";
import { gitBranch, isGitRepo } from "./git.ts";

/**
 * How much is uncommitted, without building the diffs.
 *
 * The change bar shows this continuously, so it has to be cheap: `collectWorkspaceDiff` reads
 * every changed file twice and computes hunks, which is right for a panel you opened and wrong
 * for a number that sits on screen all session.
 *
 * Counted the way the review panel counts, because the two are read together — the bar says
 * 34k and the panel it opens says 10k, and one of them is now a lie. Both skip blobs over
 * `MAX_BLOB_BYTES`: a 400KB generated lockfile is a change nobody is going to read line by
 * line, and the panel already declines to diff it.
 *
 * Tracked files come from `--numstat`; untracked ones count as entirely new, which is what
 * they are. A repository with no commits yet has no HEAD to diff against — there, everything
 * is untracked.
 */
export async function workspaceStat(
	cwd: string,
): Promise<{ branch: string | null; added: number; removed: number; files: number }> {
	if (!(await isGitRepo(cwd))) return { branch: null, added: 0, removed: 0, files: 0 };

	/*
	 * The same list the panel walks, truncated at the same point.
	 *
	 * Counting from a different enumeration is how the bar came to say 34k while the panel it
	 * opens said 10k. Both now start from `status -uall` and stop at `MAX_FILES`, so the number
	 * on the bar is a promise about what you will find inside.
	 *
	 * The three reads are independent, so they go at once. Each one is a process spawn — cheap on
	 * its own and not cheap three deep, on a call the window blocks on every time it opens a
	 * project or moves between conversations.
	 */
	const [branch, status, hasHead] = await Promise.all([
		gitBranch(cwd),
		git(cwd, ["status", "--porcelain=v1", "-uall", "-z"]).catch(() => ""),
		git(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true).catch(() => false),
	]);
	const entries = status.split("\0").filter(Boolean).slice(0, MAX_FILES);

	// One `--numstat` for every tracked change, rather than a git call per file.
	const tracked = new Map<string, { added: number; removed: number }>();
	if (hasHead) {
		const numstat = await git(cwd, ["diff", "--numstat", "HEAD"]).catch(() => "");
		for (const line of numstat.split("\n")) {
			if (!line.trim()) continue;
			const [plus, minus, path] = line.split("\t");
			// Binary files report "-" for both counts; they change, but not by a line count.
			if (path) tracked.set(path, { added: Number.parseInt(plus, 10) || 0, removed: Number.parseInt(minus, 10) || 0 });
		}
	}

	let added = 0;
	let removed = 0;

	const fresh: string[] = [];
	for (const entry of entries) {
		const path = entry.slice(3);
		if (!path) continue;

		const known = tracked.get(path);
		if (known) {
			added += known.added;
			removed += known.removed;
			continue;
		}
		fresh.push(path);
	}

	// Untracked: every line is an addition. Read together rather than one after another — a
	// directory of new files is the ordinary case, and serially it is one round trip per file.
	for (const count of await mapLimit(fresh, (path) => countNewFile(cwd, path))) added += count.added;

	return { branch, added, removed, files: entries.length };
}

/* ---------------------------------------------------------------------------
 * The Git panel's surface.
 *
 * Everything above this line serves the composer's status bar, which asks one question: how
 * much is uncommitted. A panel asks the questions you act on — what exactly changed, what is
 * staged, what happened before this, how does this branch differ from that one — and each of
 * those is a different git plumbing call.
 * ------------------------------------------------------------------------- */

/** The empty tree, so the first commit in a repository can be diffed against something. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitStatusFile {
	path: string;
	status: WorkspaceDiffFile["status"];
	/** Both can be true: a file edited after part of it was staged. */
	staged: boolean;
	unstaged: boolean;
	added: number;
	removed: number;
}

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	/**
	 * Commits this branch has that its upstream does not, and the reverse.
	 *
	 * Both are 0 whenever there is no upstream, because that is all `git status` reports — which is
	 * why nothing should read them without looking at `remoteState` first. `unpushed` is the number
	 * to show.
	 */
	ahead: number;
	behind: number;
	staged: GitStatusFile[];
	unstaged: GitStatusFile[];
	/** Which of the situations in `git-remote-state.ts` this checkout is in. */
	remoteState: RemoteState;
	/** Where a push would go. Null when no remote could be chosen — see `defaultRemote`. */
	remote: string | null;
	/** The unfinished rebase / merge / …, when `remoteState` is `in-progress`. */
	operation: GitOperation | null;
	/**
	 * Commits that exist here and not on the remote.
	 *
	 * Null means the question has no answer rather than that the answer is zero: a branch the remote
	 * has never seen has nothing to be counted against. The panel says "还没有发布过" there instead
	 * of a number, because `rev-list --count HEAD` would answer with the length of the whole branch
	 * — accurate, and no use to anyone.
	 */
	unpushed: number | null;
	/** The short sha a detached HEAD is sitting on. Null whenever a branch is checked out. */
	head: string | null;
}

/**
 * The unfinished operation, if any, read from the marker files git leaves in its directory.
 *
 * These are per-worktree, so the path has to come from `--git-dir` (inside a linked worktree that
 * is `.git/worktrees/<name>`) rather than from `--git-common-dir`, which is shared and would report
 * the main checkout's rebase as this one's.
 *
 * Worth doing on every read despite the cost: a conflicted merge leaves a dirty tree, and a rebase
 * detaches HEAD — so without this the panel would describe a stopped rebase as an ordinary detached
 * checkout, and offer push and pull buttons that git will refuse.
 */
async function operationInProgress(cwd: string): Promise<GitOperation | null> {
	const reported = await git(cwd, ["rev-parse", "--git-dir"]).then((out) => out.trim()).catch(() => null);
	if (!reported) return null;
	// `--git-dir` answers relatively from the repository root and absolutely from a linked worktree.
	const dir = isAbsolute(reported) ? reported : join(cwd, reported);
	const has = (name: string) => access(join(dir, name)).then(() => true).catch(() => false);
	const [rebaseMerge, rebaseApply, merge, cherry, revert, bisect] = await Promise.all([
		has("rebase-merge"),
		has("rebase-apply"),
		has("MERGE_HEAD"),
		has("CHERRY_PICK_HEAD"),
		has("REVERT_HEAD"),
		has("BISECT_LOG"),
	]);
	if (rebaseMerge || rebaseApply) return "rebase";
	if (merge) return "merge";
	if (cherry) return "cherry-pick";
	if (revert) return "revert";
	if (bisect) return "bisect";
	return null;
}

/** `rev-list --count`, as a number or null when the range does not resolve. */
async function countCommits(cwd: string, range: string): Promise<number | null> {
	const out = await git(cwd, ["rev-list", "--count", range]).catch(() => null);
	if (out === null) return null;
	const count = Number.parseInt(out.trim(), 10);
	return Number.isFinite(count) ? count : null;
}

/**
 * How many commits are waiting to go out, for a branch with no upstream.
 *
 * Only answerable when the remote already has a branch of the same name — someone who cloned,
 * created a branch by hand, or lost the tracking config. Then the remote's copy is a real base to
 * count against. With no such branch there is no base, and the answer is null rather than a number.
 */
async function unpushedWithoutUpstream(cwd: string, remote: string, branch: string): Promise<number | null> {
	const exists = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])
		.then(() => true)
		.catch(() => false);
	if (!exists) return null;
	return countCommits(cwd, `${remote}/${branch}..HEAD`);
}

/**
 * Status split by index, which the porcelain format already encodes.
 *
 * Each entry's first character is the index state and the second the working-tree state, so a
 * file can appear on both sides — staged as far as it was added, unstaged for what came after.
 * Presenting that as one list is what makes people commit half of what they meant to.
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
	const empty: GitStatus = {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		staged: [],
		unstaged: [],
		remoteState: "none",
		remote: null,
		operation: null,
		unpushed: null,
		head: null,
	};
	if (!(await isGitRepo(cwd))) return empty;

	/*
	 * Four independent questions, asked at once.
	 *
	 * This runs every 1.5s for the whole of a turn, so each one added is a process spawn on a hot
	 * path. Both of the new ones earn it: without the operation probe a stopped rebase is drawn as
	 * an ordinary checkout, and without the remote list an upstream cannot be split into the remote
	 * it belongs to (see `remoteOfUpstream`). Neither adds latency — they overlap the status read,
	 * which is the slow one.
	 */
	const [branch, porcelain, operation, remoteList] = await Promise.all([
		gitBranch(cwd),
		git(cwd, ["status", "--porcelain=v1", "-uall", "-z", "--branch"]).catch(() => ""),
		operationInProgress(cwd),
		git(cwd, ["remote"]).catch(() => ""),
	]);
	const remotes = remoteList.split("\n").map((name) => name.trim()).filter(Boolean);

	const parts = porcelain.split("\0").filter(Boolean);
	const header = parts[0]?.startsWith("## ") ? parts.shift()!.slice(3) : "";
	const upstreamMatch = header.match(/\.\.\.(\S+)/);
	const aheadMatch = header.match(/ahead (\d+)/);
	const behindMatch = header.match(/behind (\d+)/);

	const [stagedStat, unstagedStat] = await Promise.all([
		numstat(cwd, ["diff", "--numstat", "--cached"]),
		numstat(cwd, ["diff", "--numstat"]),
	]);

	const staged: GitStatusFile[] = [];
	const unstaged: GitStatusFile[] = [];

	/*
	 * Two passes: build the lists, then fill in the counts the untracked ones need.
	 *
	 * Counting a new file means reading it, and reading it inside the loop meant one round trip
	 * per file with nothing else in flight — on a branch with a directory of new files that is the
	 * whole cost of the call. The second pass reads them together; see `mapLimit`.
	 */
	const fresh: GitStatusFile[] = [];
	for (const entry of parts.slice(0, MAX_FILES)) {
		const index = entry[0];
		const tree = entry[1];
		// A rename's porcelain entry carries both paths separated by a NUL, already split above.
		const path = entry.slice(3);
		if (!path) continue;

		if (index && index !== " " && index !== "?") {
			staged.push({
				path,
				status: classify(index),
				staged: true,
				unstaged: false,
				...(stagedStat.get(path) ?? { added: 0, removed: 0 }),
			});
		}
		if (tree && tree !== " ") {
			const untracked = index === "?" || tree === "?";
			const file: GitStatusFile = {
				path,
				status: untracked ? "untracked" : classify(tree),
				staged: false,
				unstaged: true,
				...(untracked ? { added: 0, removed: 0 } : (unstagedStat.get(path) ?? { added: 0, removed: 0 })),
			};
			unstaged.push(file);
			if (untracked) fresh.push(file);
		}
	}

	const counts = await mapLimit(fresh, (file) => countNewFile(cwd, file.path));
	fresh.forEach((file, i) => {
		file.added = counts[i].added;
		file.removed = counts[i].removed;
	});

	const upstream = upstreamMatch?.[1] ?? null;
	const ahead = Number.parseInt(aheadMatch?.[1] ?? "0", 10);
	const standing = classifyRemote({ header, branch, upstream, operation, remotes });

	/*
	 * The count, from whichever base actually exists.
	 *
	 * Only the `no-upstream` branch costs anything, and only when a remote could be chosen — the
	 * common cases (tracking, or no remote at all) are answered without another call.
	 */
	let unpushed: number | null = null;
	if (standing.state === "tracking") unpushed = ahead;
	else if (standing.state === "no-upstream" && standing.remote && branch) {
		unpushed = await unpushedWithoutUpstream(cwd, standing.remote, branch);
	}

	/*
	 * Where a detached HEAD is sitting, so the panel can say something better than "not on a
	 * branch". Only read when there is no branch name, which is the one case it costs anything.
	 */
	const head =
		standing.state === "detached"
			? await git(cwd, ["rev-parse", "--short", "HEAD"]).then((out) => out.trim() || null).catch(() => null)
			: null;

	return {
		branch,
		upstream,
		ahead,
		behind: Number.parseInt(behindMatch?.[1] ?? "0", 10),
		staged,
		unstaged,
		remoteState: standing.state,
		remote: standing.remote,
		operation,
		unpushed,
		head,
	};
}

async function numstat(cwd: string, args: string[]): Promise<Map<string, { added: number; removed: number }>> {
	const out = await git(cwd, args).catch(() => "");
	const map = new Map<string, { added: number; removed: number }>();
	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		const [plus, minus, path] = line.split("\t");
		if (path) map.set(path, { added: Number.parseInt(plus, 10) || 0, removed: Number.parseInt(minus, 10) || 0 });
	}
	return map;
}

/** An untracked file has no other side to diff against, so every line counts as added. */
async function countNewFile(cwd: string, path: string): Promise<{ added: number; removed: number }> {
	const buffer = await readFile(join(cwd, path)).catch(() => null);
	if (!buffer || buffer.length > MAX_BLOB_BYTES || buffer.includes(0)) return { added: 0, removed: 0 };
	const text = buffer.toString("utf8");
	return { added: text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length, removed: 0 };
}

export async function stagePaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	return run(cwd, ["add", "--", ...paths]);
}

export async function unstagePaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	// `restore --staged` rather than `reset`: it leaves the working tree alone even before the
	// first commit exists, where `reset HEAD` has nothing to reset against.
	return run(cwd, ["restore", "--staged", "--", ...paths]);
}

/**
 * Throw away working-tree changes.
 *
 * Untracked files are deleted rather than restored — there is no version to restore them to.
 * The two are done in separate calls because `restore` refuses paths it does not track.
 */
export async function discardPaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const path of paths) {
		const known = await git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true).catch(() => false);
		(known ? tracked : untracked).push(path);
	}
	if (tracked.length) {
		const result = await run(cwd, ["restore", "--worktree", "--", ...tracked]);
		if (!result.ok) return result;
	}
	if (untracked.length) return run(cwd, ["clean", "-fd", "--", ...untracked]);
	return { ok: true };
}

export interface GitCommit {
	sha: string;
	shortSha: string;
	subject: string;
	/** Every parent, so the renderer can draw where lines split and rejoin. */
	parents: string[];
	author: string;
	/** ISO 8601, formatted for display in the renderer where the locale lives. */
	date: string;
	/** Branch and tag names pointing at this commit, already stripped of their prefixes. */
	refs: string[];
}

export const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P%x1e";
