/**
 * 当前分支的拉取请求：有才显示，带检查状态，点了去拉取请求那一页打开它。
 *
 * 没有「按分支查 PR」这条现成的路，于是用「我的 PR」那份列表按分支名过滤，再问主进程这个 PR 的
 * 仓库是不是这个工作区的 `origin`（`findLocalCheckout`，和拉取请求页「在本地打开」是同一个判断）。
 * 这份列表只有你提的、你在审的、你审过的——别人提、和你无关的 PR 不在里面，这一行就不出现。
 *
 * 列表先读拉取请求页留下的缓存，不够新再问一次 GitHub；一个窗口里五分钟最多问一次，切会话、
 * 开关卡片都不会多问。
 */

import { useEffect, useState } from "react";
import { CircleCheck, CircleDashed, GitPullRequest, GitPullRequestDraft, XCircle } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { focusPullRequest } from "../../store/pull-request-focus.ts";
import type { PullRequestSummary } from "../../../electron/ipc-types.ts";
import { cachedPullRequests } from "../pull-requests/index.ts";
import { ROW, Section } from "./rows.tsx";

const REFRESH_MS = 5 * 60_000;

let fetched: { at: number; list: PullRequestSummary[] } | null = null;
let fetching: Promise<PullRequestSummary[]> | null = null;
const checkouts = new Map<string, Promise<boolean>>();

function freshList(): Promise<PullRequestSummary[]> {
	if (fetched && Date.now() - fetched.at < REFRESH_MS) return Promise.resolve(fetched.list);
	fetching ??= bridge.git
		.myPullRequests()
		.then((result) => {
			fetched = { at: Date.now(), list: result.pullRequests };
			return result.pullRequests;
		})
		.catch(() => fetched?.list ?? [])
		.finally(() => {
			fetching = null;
		});
	return fetching;
}

function isCheckout(repo: string, path: string): Promise<boolean> {
	const key = `${repo}\n${path}`;
	let answer = checkouts.get(key);
	if (!answer) {
		answer = bridge.git.findLocalCheckout(repo, [path]).then((found) => found !== null, () => false);
		checkouts.set(key, answer);
	}
	return answer;
}

async function pullRequestFor(list: PullRequestSummary[], branch: string, path: string): Promise<PullRequestSummary | null> {
	const open = list.filter((pr) => pr.headRefName === branch && pr.state !== "MERGED" && pr.state !== "CLOSED");
	for (const pr of open) if (await isCheckout(pr.repo, path)) return pr;
	return null;
}

function usePullRequest(path: string | null, branch: string | null): PullRequestSummary | null {
	const [found, setFound] = useState<{ key: string; pr: PullRequestSummary | null } | null>(null);
	const key = `${path}\n${branch}`;
	useEffect(() => {
		if (!path || !branch) return;
		let live = true;
		const settle = (pr: PullRequestSummary | null) => {
			if (live) setFound({ key, pr });
		};
		void pullRequestFor(fetched?.list ?? cachedPullRequests(), branch, path).then((pr) => {
			settle(pr);
			return freshList().then((list) => pullRequestFor(list, branch, path)).then(settle);
		});
		return () => {
			live = false;
		};
	}, [key, path, branch]);
	return found?.key === key ? found.pr : null;
}

function CheckMark({ state }: { state: PullRequestSummary["checkState"] }) {
	const { t } = useI18n();
	if (state === "pass") return <CircleCheck size={13} strokeWidth={1.9} className="shrink-0 text-ok" aria-label={t("environment.checksPassed")} />;
	if (state === "fail") return <XCircle size={13} strokeWidth={1.9} className="shrink-0 text-danger" aria-label={t("environment.checksFailed")} />;
	if (state === "pending") return <CircleDashed size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" aria-label={t("environment.checksPending")} />;
	return null;
}

export function PullRequestSection({ path, branch }: { path: string | null; branch: string | null }) {
	const pr = usePullRequest(path, branch);
	if (!pr) return null;
	const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
	return (
		<Section name="pullRequest">
			<button
				type="button"
				className={ROW}
				data-ly-tip={`${pr.repo}#${pr.number}\n${pr.title}`}
				onClick={() => {
					focusPullRequest(pr);
					useApp.getState().setView("pull-requests");
				}}
			>
				<Icon size={14} strokeWidth={1.8} className={`shrink-0 ${pr.isDraft ? "text-ink-faint" : "text-ok"}`} />
				<span className="min-w-0 flex-1 truncate">
					<span className="text-ink-faint tabular-nums">#{pr.number}</span> {pr.title}
				</span>
				<CheckMark state={pr.checkState} />
			</button>
		</Section>
	);
}
