/**
 * The rules about an account, which are all rules about what somebody typed.
 *
 * Every case here came from a plausible thing to paste into that field: the API root instead of
 * the server, a trailing slash, a bare hostname, the same account added twice under two spellings.
 * None of it can be exercised by reaching a live host, and all of it decides whether the next
 * request goes anywhere.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRoot, defaultLabel, hostOf, normalizeServer, parseAccounts, sameIdentity, upsert } from "../electron/forge/accounts.ts";
import type { ForgeAccount } from "../electron/forge/types.ts";

function account(over: Partial<ForgeAccount> = {}): ForgeAccount {
	return {
		id: "a1",
		kind: "github",
		label: "kittors",
		baseUrl: "https://github.com",
		login: "kittors",
		avatarUrl: null,
		addedAt: 1,
		enabled: true,
		...over,
	};
}

test("a bare hostname is a server", () => {
	assert.equal(normalizeServer("gitlab.com"), "https://gitlab.com");
	assert.equal(normalizeServer("  git.corp.example  "), "https://git.corp.example");
});

test("trailing slashes and paths that are ours to append are dropped", () => {
	assert.equal(normalizeServer("https://gitlab.com/"), "https://gitlab.com");
	assert.equal(normalizeServer("https://gitlab.com/api/v4"), "https://gitlab.com");
	assert.equal(normalizeServer("https://git.example.com/api/v1/"), "https://git.example.com");
});

test("the GitHub API root means github.com, because that is what the person meant", () => {
	// Storing it as typed would give an account whose every link pointed at a JSON endpoint.
	assert.equal(normalizeServer("https://api.github.com"), "https://github.com");
	assert.equal(normalizeServer("api.github.com/"), "https://github.com");
});

test("a self-hosted instance under a sub-path keeps it", () => {
	assert.equal(normalizeServer("https://example.com/gitlab"), "https://example.com/gitlab");
});

test("http is allowed, because an internal instance may well be", () => {
	assert.equal(normalizeServer("http://git.internal:3000"), "http://git.internal:3000");
});

test("what is not a server is refused rather than stored", () => {
	assert.equal(normalizeServer(""), null);
	assert.equal(normalizeServer("   "), null);
	assert.equal(normalizeServer("ftp://git.example.com"), null);
	assert.equal(normalizeServer("not a url at all"), null);
});

test("each host's API root is derived, and GitHub is the one that is not a rule", () => {
	assert.equal(apiRoot({ kind: "github", baseUrl: "https://github.com" }), "https://api.github.com");
	// Enterprise answers under its own origin, which is why this cannot be one rule.
	assert.equal(apiRoot({ kind: "github", baseUrl: "https://git.corp.example" }), "https://git.corp.example/api/v3");
	assert.equal(apiRoot({ kind: "gitlab", baseUrl: "https://gitlab.com" }), "https://gitlab.com/api/v4");
	assert.equal(apiRoot({ kind: "gitee", baseUrl: "https://gitee.com" }), "https://gitee.com/api/v5");
	assert.equal(apiRoot({ kind: "gitea", baseUrl: "https://git.example.com" }), "https://git.example.com/api/v1");
});

test("the same person on the same host is one account, however it was spelled", () => {
	assert.ok(sameIdentity(account(), account({ id: "other", baseUrl: "https://github.com/" })), "a trailing slash is not a second host");
	assert.ok(sameIdentity(account(), account({ login: "KITTORS" })), "logins are not case-sensitive to a human");
	assert.ok(!sameIdentity(account(), account({ kind: "gitea" })), "same name on a different host is a different person");
	assert.ok(
		!sameIdentity(account(), account({ baseUrl: "https://git.corp.example" })),
		"and so is the same name on the company's own instance",
	);
});

test("signing in again replaces the account rather than adding a second tab", () => {
	const existing = [account()];
	const again = account({ id: "fresh-uuid", label: "重新登录" });

	const merged = upsert(existing, again);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].label, "重新登录");
	assert.equal(merged[0].id, "a1", "the old id wins, so the token already filed under it stays reachable");
});

test("a genuinely different account is appended", () => {
	const merged = upsert([account()], account({ id: "b2", kind: "gitlab", baseUrl: "https://gitlab.com", login: "kittors" }));
	assert.equal(merged.length, 2);
});

test("a stored entry missing something essential is dropped, not defaulted", () => {
	const parsed = parseAccounts([
		account(),
		{ ...account({ id: "b" }), baseUrl: "" },
		{ ...account({ id: "c" }), kind: "bitbucket" },
		{ ...account({ id: "" }) },
		null,
	]);
	assert.deepEqual(parsed.map((a) => a.id), ["a1"]);
});

test("a file written before `enabled` existed arrives switched on", () => {
	const raw = { ...account() } as Partial<ForgeAccount>;
	delete raw.enabled;
	assert.equal(parseAccounts([raw])[0].enabled, true);
});

test("a stored address is normalised on the way in, not only on the way out", () => {
	assert.equal(parseAccounts([account({ baseUrl: "https://gitlab.com/api/v4/" })])[0].baseUrl, "https://gitlab.com");
});

test("parsing accepts both the file's shape and a bare array", () => {
	assert.equal(parseAccounts({ accounts: [account()] }).length, 1);
	assert.equal(parseAccounts([account()]).length, 1);
	assert.equal(parseAccounts(null).length, 0);
});

test("名字只管名字，主机归徽章和第二行管", () => {
	/*
	 * 这条从前断言的是 `kittors · gitlab.com`，理由是同名歧义。理由没错，错在答案塞进了名字里：
	 * 设置页的第二行看见 `login !== label` 就把登录名又写了一遍，标签页那边则有个 `short()` 专门
	 * 再把主机切掉。屏幕上是一行 `kittors · github.com` 顶着一行 `kittors`，而 `github.com` 旁边
	 * 那枚徽章已经答过一次了。
	 */
	assert.equal(defaultLabel({ login: "kittors", name: "K", avatarUrl: null }), "kittors");
	// 登录名拿不到时退到显示名，两个都没有才退到那个词——这一段没变。
	assert.equal(defaultLabel({ login: "  ", name: "K", avatarUrl: null }), "K");
	assert.equal(hostOf("https://git.corp.example:8443/x"), "git.corp.example:8443");
});
