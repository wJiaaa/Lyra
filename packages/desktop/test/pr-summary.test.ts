/**
 * Turning one GraphQL answer into the rows the list draws.
 *
 * Everything here is a rule that only shows itself against a real response: a search that also
 * matches issues, an error delivered with a 200, a pull request that is in two buckets at once,
 * and CI's dozen states reduced to the three a reviewer acts on. None of it can be exercised
 * without either a network or these fixtures.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStateOf, dedupe, parseSearch, type SearchNode, toSummary } from "../electron/pr-summary.ts";
import { pr } from "./pr-fixtures.ts";

function node(over: Partial<SearchNode> = {}): SearchNode {
	return {
		number: 1,
		title: "Bump the actions group across 1 directory with 5 updates",
		url: "https://github.com/kittors/Plume/pull/1",
		state: "OPEN",
		isDraft: false,
		createdAt: "2026-08-16T00:00:00Z",
		updatedAt: "2026-08-19T09:00:00Z",
		additions: 16,
		deletions: 16,
		headRefName: "dependabot/github_actions/actions-ed7ea029e0",
		reviewDecision: null,
		author: { login: "dependabot", avatarUrl: "https://avatars.githubusercontent.com/in/29110?s=64" },
		repository: { nameWithOwner: "kittors/Plume" },
		comments: { totalCount: 2 },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
		...over,
	};
}

function answer(buckets: { reviewing?: unknown[]; authored?: unknown[]; reviewed?: unknown[] }): unknown {
	return {
		data: {
			reviewing: { nodes: buckets.reviewing ?? [] },
			authored: { nodes: buckets.authored ?? [] },
			reviewed: { nodes: buckets.reviewed ?? [] },
		},
	};
}

test("a row carries everything the list draws, from one search", () => {
	const summary = toSummary(node(), "reviewing", "acct-1");

	assert.equal(summary.repo, "kittors/Plume");
	assert.equal(summary.author, "dependabot");
	assert.equal(summary.avatarUrl, "https://avatars.githubusercontent.com/in/29110?s=64");
	assert.equal(summary.additions, 16);
	assert.equal(summary.deletions, 16);
	assert.equal(summary.headRefName, "dependabot/github_actions/actions-ed7ea029e0");
	assert.equal(summary.comments, 2);
	assert.equal(summary.checkState, "fail", "the head commit's rollup, which is why the row can show a red dot");
	assert.equal(summary.relation, "reviewing");
	assert.equal(summary.accountId, "acct-1", "which account saw it, since owner/name is not unique across hosts");
});

test("a pull request with no checks is not one whose checks are pending", () => {
	assert.equal(toSummary(node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), "authored", "acct-1").checkState, null);
	assert.equal(toSummary(node({ commits: { nodes: [] } }), "authored", "acct-1").checkState, null, "and neither is one with no commits");
});

test("CI's states come down to the three a reviewer acts on", () => {
	assert.equal(checkStateOf("SUCCESS"), "pass");
	assert.equal(checkStateOf("FAILURE"), "fail");
	assert.equal(checkStateOf("ERROR"), "fail");
	assert.equal(checkStateOf("PENDING"), "pending");
	assert.equal(checkStateOf("EXPECTED"), "pending", "announced and not started reads the same as running");
	assert.equal(checkStateOf(null), null);
	assert.equal(checkStateOf(""), null);
});

test("a search for issues that matched an issue drops it", () => {
	// `type: ISSUE` matches both; an issue comes back as a node with none of the pull request
	// fragment's fields on it.
	const parsed = parseSearch(answer({ authored: [node(), {}, null] }));
	assert.deepEqual(
		parsed.authored.map((n) => n.number),
		[1],
	);
});

test("an error delivered with a 200 is still an error", () => {
	const body = {
		data: { reviewing: { nodes: [] }, authored: { nodes: [] }, reviewed: { nodes: [] } },
		errors: [{ message: "API rate limit exceeded" }],
	};
	assert.throws(() => parseSearch(body), /rate limit/, "reporting this as an empty list would be the worst of both");
});

test("a bucket the server left out is an empty bucket, not a crash", () => {
	const parsed = parseSearch({ data: { authored: { nodes: [node()] } } });
	assert.equal(parsed.authored.length, 1);
	assert.deepEqual(parsed.reviewing, []);
	assert.deepEqual(parsed.reviewed, []);
});

test("a pull request in two buckets keeps the more urgent one", () => {
	const mine = pr({ relation: "reviewing", number: 5 });
	const also = pr({ relation: "reviewed", number: 5 });

	const rows = dedupe([[mine], [], [also]]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].relation, "reviewing", "what is asked of you outranks what you have already said");
});

test("the list is newest first", () => {
	const older = pr({ relation: "authored", number: 1, updatedAt: "2026-08-01T00:00:00Z" });
	const newer = pr({ relation: "authored", number: 2, updatedAt: "2026-08-09T00:00:00Z" });

	assert.deepEqual(
		dedupe([[older, newer]]).map((row) => row.number),
		[2, 1],
	);
});
