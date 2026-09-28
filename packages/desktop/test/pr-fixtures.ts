/**
 * One pull request row, with everything filled in and nothing meaningful in it.
 *
 * Shared by the three suites that reason about the list — grouping, syncing, and the search
 * results they are built from — so that adding a field to a row is one edit rather than three, and
 * so that no suite quietly stops covering a field because its own local factory never had it.
 */

import type { PullRequestSummary } from "../electron/ipc-shapes.ts";

export function pr(
	over: Partial<PullRequestSummary> & { relation: PullRequestSummary["relation"] },
): PullRequestSummary {
	return {
		accountId: "acct-1",
		repo: "kittors/plume",
		number: 1,
		title: "fix: something",
		author: "someone",
		avatarUrl: "https://avatars.githubusercontent.com/u/1?s=64",
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/kittors/plume/pull/1",
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		comments: 0,
		additions: 12,
		deletions: 3,
		headRefName: "fix/something",
		checkState: "pass",
		reviewDecision: null,
		...over,
	};
}
