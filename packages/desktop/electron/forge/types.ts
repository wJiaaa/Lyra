/**
 * What a code host is, to this app.
 *
 * Pull requests used to come from `gh`, which meant three things at once: GitHub only, a CLI that
 * had to be installed and separately logged in, and one identity — whichever account `gh` happened
 * to hold. All three were the same limitation wearing different clothes, and none of them are
 * about pull requests.
 *
 * So the shape here is a *driver*: an account plus a token, and six things a review screen needs.
 * GitHub, GitLab, Gitee and Gitea each answer them over their own HTTP API, and a self-hosted
 * instance of any of them is the same driver with a different address. Adding a fifth host is one
 * file that implements this interface, not a change to anything that draws a row.
 */

import type { PullRequestDetail, PullRequestSummary, WorkspaceDiffFile } from "../ipc-shapes.ts";

/** The hosts this app knows how to talk to. Self-hosted instances reuse the kind they run. */
export type ForgeKind = "github" | "gitlab" | "gitee" | "gitea";

/** What a review can say. `approve` and `request-changes` are decisions; `comment` is not. */
export type ReviewVerdict = "approve" | "request-changes" | "comment";

/**
 * One signed-in identity, minus the secret.
 *
 * Free of the token on purpose — this object is what crosses IPC and lands in the renderer, and a
 * token that travels to a page is a token that ends up in a screenshot. The secret lives in the
 * vault next door, keyed by `id`, and only the main process ever reads it.
 *
 * `baseUrl` is the *server*, as a person would type it — `https://github.com`,
 * `https://git.corp.example`. Where each host hangs its API off that is the driver's business and
 * is derived, never stored: asking someone to know that GitHub answers on `api.github.com`, GitHub
 * Enterprise on `/api/v3`, GitLab on `/api/v4` and Gitea on `/api/v1` is asking them to do the
 * app's homework.
 */
export interface ForgeAccount {
	id: string;
	kind: ForgeKind;
	/** What the user typed, or `login · host` when they typed nothing. Shown on the tab. */
	label: string;
	/** The server's root, no trailing slash. Web pages live here; the API is derived from it. */
	baseUrl: string;
	login: string;
	avatarUrl: string | null;
	addedAt: number;
	/**
	 * Off means "skip me", not "forget me".
	 *
	 * Someone with four accounts is usually working in one of them. Switching an account off keeps
	 * the token and stops it being fetched, which is the difference between quieting a list and
	 * having to find the token again next week.
	 */
	enabled: boolean;
	/** Last failure from this account, kept so a tab can say why it is empty. */
	lastError?: string;
}

/** An account with its secret, which is the only form a driver can use. */
export interface ForgeConnection {
	account: ForgeAccount;
	token: string;
}

/** Who a token belongs to, which is the one thing worth checking before saving it. */
export interface ForgeIdentity {
	login: string;
	name: string;
	avatarUrl: string | null;
}

/**
 * The six things a review screen asks of a host.
 *
 * Deliberately not "everything the API can do". Each of these is a question the UI already asks —
 * what is waiting on me, what is in this one, what changed, and the three ways of replying — and a
 * driver that answers them is complete regardless of what else its host offers.
 *
 * Every method may throw; the caller turns a throw into a message on a row rather than an empty
 * list, because "GitLab is down" and "you have no merge requests" must not look the same.
 */
export interface ForgeDriver {
	kind: ForgeKind;
	/** Who this token is, used to name the account and to prove the token works before saving it. */
	identify(conn: ForgeConnection): Promise<ForgeIdentity>;
	list(conn: ForgeConnection): Promise<PullRequestSummary[]>;
	detail(conn: ForgeConnection, repo: string, number: number): Promise<PullRequestDetail>;
	diff(conn: ForgeConnection, repo: string, number: number): Promise<WorkspaceDiffFile[]>;
	comment(conn: ForgeConnection, repo: string, number: number, body: string): Promise<void>;
	review(conn: ForgeConnection, repo: string, number: number, verdict: ReviewVerdict, body: string): Promise<void>;
}

/**
 * What the "add an account" form needs to know about a host before it has one.
 *
 * `tokenUrl` matters more than it looks: every one of these hosts buries token creation somewhere
 * different, and three of the four accept the scopes as query parameters — so the link can land on
 * a form that is already filled in, and the step that loses people becomes one click.
 */
export interface ForgeKindInfo {
	kind: ForgeKind;
	name: string;
	/** Suggested server address for the hosted instance. Empty for hosts that are always self-run. */
	baseUrl: string;
	/** Where to go create a token on the hosted instance, scopes pre-filled where possible. */
	tokenUrl: string;
	/** Which permissions the token needs, said the way that host says it. */
	scopes: string;
	/** One line about what is different here, shown under the name while choosing. */
	note: string;
	/** Whether a self-hosted address is the normal case rather than the exception. */
	selfHosted: boolean;
}

export const FORGE_KINDS: ForgeKindInfo[] = [
	{
		kind: "github",
		name: "GitHub",
		baseUrl: "https://github.com",
		tokenUrl: "https://github.com/settings/tokens/new?scopes=repo,read:org,read:user&description=Plume",
		scopes: "repo · read:org · read:user",
		note: "GitHub Enterprise 填自己的地址即可，接口一样。",
		selfHosted: false,
	},
	{
		kind: "gitlab",
		name: "GitLab",
		baseUrl: "https://gitlab.com",
		tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens?name=Plume&scopes=api",
		scopes: "api",
		note: "自建 GitLab 把地址换成你的域名，路径 /api/v4 由应用自己补。",
		selfHosted: true,
	},
	{
		kind: "gitee",
		name: "Gitee 码云",
		baseUrl: "https://gitee.com",
		tokenUrl: "https://gitee.com/personal_access_tokens/new",
		scopes: "projects · pull_requests · user_info",
		note: "Gitee 没有跨仓库的 PR 搜索，应用会扫描你最近推送过的仓库。",
		selfHosted: false,
	},
	{
		kind: "gitea",
		name: "Gitea / Forgejo",
		baseUrl: "",
		tokenUrl: "",
		scopes: "read:user · read:repository · write:issue · write:repository",
		note: "自建为主。填服务地址，例如 https://git.example.com。",
		selfHosted: true,
	},
];
