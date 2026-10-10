import { create } from "zustand";

/**
 * 有人要拉取请求那一页打开某一个——从环境卡片里那一行。
 *
 * 和 `job-focus.ts` 同一个形状：一次请求，页面挂上来以后照着选中它，然后清掉。账号要一起带上，
 * 同一个 `owner/name` 在 github.com 和公司自己的 GitHub 上都可能有，见 `PrRef`。
 */
export const usePullRequestFocus = create<{ focus: { accountId: string; repo: string; number: number; at: number } | null }>(() => ({ focus: null }));

export function focusPullRequest(pr: { accountId: string; repo: string; number: number }): void {
	usePullRequestFocus.setState({ focus: { accountId: pr.accountId, repo: pr.repo, number: pr.number, at: Date.now() } });
}
