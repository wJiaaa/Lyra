/**
 * The sidebar's list, as rules rather than as a rendering.
 *
 * These were four conditions buried in a 474-line component, and each one is the kind that is only
 * noticed when it is wrong: an emptied project vanishing when it should have stayed, a search
 * dissolving the projects it filtered within, a half-started conversation disappearing out from
 * under the message being sent in it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptiedProjects, groupSessions, isScratch, listableSessions, nestSpawned, withSpawned } from "../src/lib/sidebar-grouping.ts";

type Session = Parameters<typeof listableSessions>[0][number];

/**
 * The projects here are named for their folders (`id` is the path), and a conversation records the
 * one it runs in unless a test says otherwise — `project: undefined` for one that records none.
 */
function session(over: Partial<Session>): Session {
	const made = {
		id: "s1",
		title: "会话",
		cwd: "/a",
		projectName: "a",
		messageCount: 2,
		archived: false,
		updatedAt: 0,
		createdAt: 0,
		...over,
	};
	return ("project" in over ? made : { ...made, project: made.cwd }) as Session;
}

const projects = [
	{ id: "/c", path: "/c", name: "c", lastOpenedAt: 2 },
	{ id: "/a", path: "/a", name: "a", lastOpenedAt: 1 },
];

test("archived sessions are not listed; they live in settings", () => {
	const kept = listableSessions([session({ id: "x", archived: true }), session({ id: "y" })], null);
	assert.deepEqual(
		kept.map((s) => s.id),
		["y"],
	);
});

test("an empty session is not a conversation yet, unless it is the one being started", () => {
	const sessions = [session({ id: "empty", messageCount: 0 }), session({ id: "started", messageCount: 0 })];
	assert.deepEqual(
		listableSessions(sessions, "started").map((s) => s.id),
		["started"],
	);
});

test("archived sessions never enter the live list even if active", () => {
	const filed = session({ id: "filed", archived: true });
	assert.deepEqual(
		listableSessions([filed, session({ id: "other" })], "filed").map((s) => s.id),
		["other"],
	);
	assert.deepEqual(
		listableSessions([filed, session({ id: "other" })], "other").map((s) => s.id),
		["other"],
	);
});

test("a conversation that has just been sent to stays listed after you click away", () => {
	/*
	 * The row is only exempt from the "must have a message" rule while it is selected, so a session
	 * carrying the stored `messageCount: 0` vanished the moment another conversation was opened.
	 * `send` counts the message it just sent, which is what this depends on.
	 */
	const justSent = session({ id: "just-sent", messageCount: 1 });
	assert.deepEqual(
		listableSessions([justSent], "somebody-else").map((s) => s.id),
		["just-sent"],
	);
});

test("a project that never had a session takes a row only where asked, and not while searching", () => {
	const unused = (query: string, showUnused: boolean) =>
		groupSessions([], projects, query, [], [], undefined, "updatedAt", new Set(), false, showUnused).projects.map((g) => g.path);
	assert.deepEqual(unused("", false), [], "归档视图那样不要的，默认不占行");
	assert.deepEqual(unused("", true), ["/c", "/a"], "刚建好的项目在常规列表里要能点到");
	assert.deepEqual(unused("登录", true), [], "搜索时没有会话可匹配，不占行");
});

/*
 * 会话全归档之后，那一行留不留——是个设置，不是个定论。
 *
 * 归档掉最后一条对话是在说这个项目告一段落了，有人希望它跟着一起收起来。但项目从侧边栏凭空
 * 消失，也是让人找不着自己活儿的一种方式。所以默认留着，想收起来的自己去开。
 */
test("an emptied project keeps its row by default", () => {
	const emptied = new Set(["/c", "/a"]);
	const { projects: rest } = groupSessions([], projects, "", [], [], undefined, "updatedAt", emptied, false);
	assert.deepEqual(
		rest.map((g) => g.path),
		["/c", "/a"],
		"默认不消失",
	);
});

test("with hideEmptiedProjects on, an emptied project folds away", () => {
	const emptied = new Set(["/c", "/a"]);
	const { projects: rest } = groupSessions([], projects, "", [], [], undefined, "updatedAt", emptied, true);
	assert.deepEqual(rest, []);
});

test("a project that never had a session is unaffected by the setting", () => {
	/*
	 * 「一条都没有过」和「都归档了」是两回事。前者不管那个开关开没开，都不占行。
	 */
	for (const hide of [false, true]) {
		const { projects: rest } = groupSessions([], projects, "", [], [], undefined, "updatedAt", new Set(), hide);
		assert.deepEqual(rest, [], `hideEmptied=${hide}`);
	}
});

test("a project still holding one live session is never folded away", () => {
	const live = session({ id: "alive", cwd: "/c" });
	// 归档了一条、还剩一条：项目还在进行中，开关开着也得留着。
	const { projects: rest } = groupSessions([live], projects, "", [], [], undefined, "updatedAt", new Set(["/c"]), true);
	assert.deepEqual(
		rest.map((g) => g.path),
		["/c"],
	);
});

test("searching filters sessions without dissolving their projects", () => {
	const sessions = [
		session({ id: "1", title: "改一下登录", cwd: "/a" }),
		session({ id: "2", title: "登录页样式", cwd: "/c" }),
		session({ id: "3", title: "无关的事", cwd: "/a" }),
	];
	const { projects: rest } = groupSessions(sessions, projects, "登录");
	assert.deepEqual(
		rest.map((g) => [g.path, g.sessions.map((s) => s.id)]),
		[
			["/c", ["2"]],
			["/a", ["1"]],
		],
	);
});

/*
 * 只有登记过的项目占行，顺序照登记的来。
 *
 * 会话记着一个不在列表里的项目（被移除了），或者什么也没记，都进「最近」——以前会照着它的文件夹
 * 现造一个「项目」排在最后，于是打开过的文件夹都成了项目。
 */
test("only registered projects take rows, in their order; a conversation in none is loose", () => {
	const sessions = [session({ id: "1", cwd: "/z", projectName: "z" }), session({ id: "2", cwd: "/a" }), session({ id: "3", cwd: "/c", project: undefined })];
	const { projects: rest, loose } = groupSessions(sessions, projects, "");
	assert.deepEqual(
		rest.map((g) => g.path),
		["/a"],
	);
	assert.deepEqual(loose.map((s) => s.id).sort(), ["1", "3"]);
});
test("project sessions follow custom sessionOrder only in manual sort mode", () => {
	const s1 = session({ id: "s1", cwd: "/a", project: "p1", updatedAt: 100, createdAt: 300 });
	const s2 = session({ id: "s2", cwd: "/a", project: "p1", updatedAt: 200, createdAt: 100 });
	const s3 = session({ id: "s3", cwd: "/a", project: "p1", updatedAt: 300, createdAt: 200 });
	const sNew = session({ id: "sNew", cwd: "/a", project: "p1", updatedAt: 400, createdAt: 400 });

	// In manual sort mode
	const { projects: manualRes } = groupSessions(
		[s1, s2, s3, sNew],
		[{ id: "p1", name: "A", path: "/a", lastOpenedAt: 0 }],
		"",
		[],
		[],
		{ p1: ["s3", "s1", "s2"] },
		"manual",
	);
	assert.deepEqual(
		manualRes[0].sessions.map((s) => s.id),
		["sNew", "s3", "s1", "s2"],
	);

	// In updatedAt mode, sessionOrder should be bypassed and sorted by updatedAt desc
	const { projects: updateRes } = groupSessions(
		[s1, s2, s3, sNew],
		[{ id: "p1", name: "A", path: "/a", lastOpenedAt: 0 }],
		"",
		[],
		[],
		{ p1: ["s3", "s1", "s2"] },
		"updatedAt",
	);
	assert.deepEqual(
		updateRes[0].sessions.map((s) => s.id),
		["sNew", "s3", "s2", "s1"],
	);

	// In createdAt mode, sorted by createdAt desc
	const { projects: createdRes } = groupSessions(
		[s1, s2, s3, sNew],
		[{ id: "p1", name: "A", path: "/a", lastOpenedAt: 0 }],
		"",
		[],
		[],
		{ p1: ["s3", "s1", "s2"] },
		"createdAt",
	);
	assert.deepEqual(
		createdRes[0].sessions.map((s) => s.id),
		["sNew", "s1", "s3", "s2"],
	);
});


test("project-less conversations are loose rows, not a project each and not a project at all", () => {
	/*
	 * They are real sessions worth returning to — a review asked about yesterday should be one
	 * click away — but their directory is the app's own. Grouped by directory the usual way, each
	 * one becomes a project called `owner-repo-6381` sitting among the user's actual work; grouped
	 * under one folder row, that row is a project named after not being one.
	 */
	const roots = ["/home/.plume/workspaces"];
	const sessions = [
		session({ id: "work", cwd: "/a" }),
		session({ id: "review-1", cwd: "/home/.plume/workspaces/owner-repo-1" }),
		session({ id: "review-2", cwd: "/home/.plume/workspaces/owner-repo-2" }),
	];

	const { projects: rest, loose } = groupSessions(sessions, projects, "", roots);

	assert.deepEqual(
		loose.map((s) => s.id),
		["review-1", "review-2"],
		"both are loose despite living in different directories",
	);
	assert.deepEqual(
		rest.map((g) => g.path),
		["/a"],
		"and none of them invents a project",
	);
});

test("loose rows are newest first, whatever order they arrived in", () => {
	const roots = ["/home/.plume/workspaces"];
	const sessions = [
		session({ id: "older", cwd: "/home/.plume/workspaces/general", updatedAt: 10 }),
		session({ id: "newest", cwd: "/home/.plume/workspaces/general", updatedAt: 30 }),
		session({ id: "middle", cwd: "/home/.plume/workspaces/general", updatedAt: 20 }),
	];
	assert.deepEqual(
		groupSessions(sessions, [], "", roots).loose.map((s) => s.id),
		["newest", "middle", "older"],
	);
});

test("a project whose path merely starts the same is still its own project", () => {
	// The root arrives without a trailing slash; a plain `startsWith` would swallow
	// `/home/.plume/prototypes` into the loose rows.
	const prototypes = [{ id: "/home/.plume/prototypes", path: "/home/.plume/prototypes", name: "prototypes", lastOpenedAt: 0 }];
	const sessions = [session({ id: "prototypes", cwd: "/home/.plume/prototypes" })];

	const { projects: rest, loose } = groupSessions(sessions, prototypes, "", ["/home/.plume/pr"]);
	assert.deepEqual(loose, []);
	assert.equal(rest[0].path, "/home/.plume/prototypes");
});

test("on Windows the roots are backslashed, and sessions under them are still project-less", () => {
	// The roots come from the main process's `path.join`. Matching them with `root + "/"` never
	// succeeded there, so every PR review and every project-less chat became a project of its own.
	const root = "C:\\Users\\me\\.plume";
	const registered = [{ id: `${root}\\prototypes`, path: `${root}\\prototypes`, name: "prototypes", lastOpenedAt: 0 }];
	const sessions = [
		session({ id: "review", cwd: `${root}\\pr\\owner-repo-1` }),
		session({ id: "chat", cwd: `${root}\\workspaces\\general` }),
		session({ id: "project", cwd: `${root}\\prototypes` }),
	];

	const { projects: rest, loose } = groupSessions(sessions, registered, "", [`${root}\\workspaces`, `${root}\\pr`]);
	assert.deepEqual(loose.map((s) => s.id).sort(), ["chat", "review"]);
	// The separator still counts: `…\prototypes` is not inside `…\pr`.
	assert.deepEqual(rest.map((group) => group.path), [`${root}\\prototypes`]);
	// And the root itself is not inside itself, as on the other platforms.
	assert.equal(isScratch(`${root}\\pr`, [`${root}\\pr`]), false);
	assert.equal(isScratch(`${root}\\pr\\x`, [`${root}\\pr\\`]), true);
});

test("with no roots known yet, nothing is treated as project-less", () => {
	const there = "/home/.plume/workspaces/owner-repo-1";
	const sessions = [session({ id: "review", cwd: there })];
	const { projects: rest, loose } = groupSessions(sessions, [{ id: there, path: there, name: "review", lastOpenedAt: 0 }], "", []);
	assert.deepEqual(loose, []);
	assert.equal(rest[0].path, there);
});

/*
 * 会话归哪个项目，只看它记下的那个，不看它在哪个文件夹里跑。
 *
 * 一个文件夹可以在好几个项目里，所以「哪个项目列着这个文件夹」从来只是猜。在附加文件夹里开的会话
 * 记着项目，照样归它；在某个项目的文件夹或子目录里、却什么也没记的会话，是单独打开文件夹时开的，
 * 不属于任何项目。
 */
const multi = [{ id: "/app", path: "/app", name: "app", lastOpenedAt: 1, folders: ["/app", "/api"] }];

test("a conversation is filed by the project it records, not by the folder it runs in", () => {
	const sessions = [
		session({ id: "in-app", cwd: "/app" }),
		session({ id: "in-api", cwd: "/api", project: "/app" }),
		session({ id: "deep", cwd: "/app/packages", project: undefined }),
		session({ id: "bare", cwd: "/app", project: undefined }),
	];
	const { projects: rest, loose } = groupSessions(sessions, multi, "");
	assert.deepEqual(
		rest.map((g) => [g.path, g.sessions.map((s) => s.id).sort()]),
		[["/app", ["in-api", "in-app"]]],
	);
	assert.deepEqual(loose.map((s) => s.id).sort(), ["bare", "deep"]);
});

/*
 * 项目按 id 认：两个项目的主文件夹相同，侧栏上就是两行，各放记着自己的会话。
 */
test("two projects on one folder take a row each, and each holds what records it", () => {
	const projects = [
		{ id: "new-uuid", path: "/app", name: "新项目", lastOpenedAt: 2 },
		{ id: "/app", path: "/app", name: "app", lastOpenedAt: 1 },
	];
	const sessions = [
		session({ id: "old", cwd: "/app" }),
		session({ id: "mine", cwd: "/app", project: "new-uuid" }),
		session({ id: "orphan", cwd: "/app", project: "removed" }),
		session({ id: "bare", cwd: "/app", project: undefined }),
	];
	const { projects: rest, loose } = groupSessions(sessions, projects, "", [], [], undefined, "updatedAt", new Set(), false, true);
	assert.deepEqual(
		rest.map((g) => [g.id, g.name, g.sessions.map((s) => s.id)]),
		[
			["new-uuid", "新项目", ["mine"]],
			["/app", "app", ["old"]],
		],
	);
	assert.deepEqual(loose.map((s) => s.id).sort(), ["bare", "orphan"], "a removed project or none: loose, not a row made from the folder");
});

/*
 * 「移除项目」得真的把它从列表里去掉。
 *
 * `removeProject` 只把条目从 `settings.projects` 里滤掉，注释说这是「stop listing this, not
 * delete my work」。可这里会照着会话的 `cwd` 把分组重新造出来——移除项目并不删它的会话，于是
 * 那些会话还指着同一个路径，分组下一帧就回来了。用户看到的就是「删不掉」：目录都从磁盘上删了，
 * 侧边栏里那一组还在。
 *
 * 所以移除的时候要连同它的会话一起归档——归档是既有的、可撤销的手段，会话一条没少，只是不在
 * 主列表里了。这条钉的是「归档之后不会被重新造出来」。
 */
test("移除项目之后，它不会因为还有会话就被重新造回来", () => {
	const gone = "/removed";
	const sessions = [
		session({ id: "kept", cwd: "/a" }),
		// 它的会话已经跟着一起归档了，所以进不了列表。
		session({ id: "with-removed", cwd: gone, projectName: "removed", archived: true }),
	];
	const { projects: rest } = groupSessions(listableSessions(sessions, null), projects, "");
	assert.equal(
		rest.some((group) => group.path === gone),
		false,
		"归档掉它的会话之后，这一组不该再出现",
	);
});

test("只移除条目、会话还留在列表里，它们进「最近」，那一组也不会长回来", () => {
	const gone = "/removed";
	const sessions = [session({ id: "orphan", cwd: gone, projectName: "removed" })];
	const { projects: rest, loose } = groupSessions(listableSessions(sessions, null), projects, "");
	assert.equal(rest.some((group) => group.path === gone), false);
	assert.deepEqual(loose.map((s) => s.id), ["orphan"]);
});

/*
 * 跑在自己工作树里的会话，归它出来的那个项目。
 *
 * 工作树的路径不属于任何登记过的项目，会话记下的项目才是它的归属——按 `cwd` 分组的时候，每开一个
 * 这样的会话就多一个同名的项目文件夹，会话还会在建好工作树的那一刻从原项目下跳过去。
 */
test("a conversation in a worktree of its own is filed under the project it was made from", () => {
	const inWorktree = session({ id: "wt", cwd: "/home/.plume/worktrees/a-1234abcd", projectName: "a", project: "/a", worktree: { project: "/a", branch: "plume/session-1234abcd" } });
	const plain = session({ id: "plain", cwd: "/a" });
	const { projects: groups } = groupSessions([inWorktree, plain], projects, "");
	assert.deepEqual(
		groups.filter((g) => g.sessions.length).map((g) => [g.path, g.sessions.map((s) => s.id).sort()]),
		[["/a", ["plain", "wt"]]],
		"one project, not a second folder named after the worktree",
	);
});

test("archiving a project's worktree conversations empties that project, by its id", () => {
	const archived = [session({ id: "wt", archived: true, cwd: "/home/.plume/worktrees/a-1234abcd", project: "/a", worktree: { project: "/a", branch: "plume/session-1234abcd" } })];
	assert.deepEqual([...emptiedProjects([], archived)], ["/a"]);
	assert.deepEqual([...emptiedProjects([session({ id: "live", cwd: "/a" })], archived)], [], "a live conversation still in the project keeps it");
});

const from = (sessionId: string) => ({ spawnedFrom: { sessionId, toolCallId: "toolu_1" } });

test("a conversation started from a suggestion sits under the one that suggested it, not beside it", () => {
	const nested = nestSpawned(
		groupSessions(
			[
				session({ id: "parent", createdAt: 1 }),
				session({ id: "later", createdAt: 5, ...from("parent") }),
				session({ id: "child", createdAt: 3, ...from("parent") }),
				session({ id: "grandchild", createdAt: 4, ...from("child") }),
				session({ id: "other", createdAt: 2 }),
			],
			projects,
			"",
		),
	);
	assert.deepEqual(nested.projects.find((group) => group.path === "/a")?.sessions.map((s) => s.id), ["parent", "other"]);
	assert.deepEqual(nested.spawned.parent.map((s) => s.id), ["child", "later"], "oldest first");
	assert.deepEqual(withSpawned(nested.projects[0].sessions, nested.spawned).map((s) => s.id), ["parent", "child", "grandchild", "later", "other"]);
});

test("a fork sits under the conversation it was forked from, beside that one's suggestions", () => {
	const nested = nestSpawned(
		groupSessions(
			[
				session({ id: "parent", createdAt: 1 }),
				session({ id: "fork", createdAt: 3, forkedFrom: { sessionId: "parent" } }),
				session({ id: "child", createdAt: 2, ...from("parent") }),
				session({ id: "orphan-fork", createdAt: 4, forkedFrom: { sessionId: "deleted" } }),
			],
			projects,
			"",
		),
	);
	assert.deepEqual(nested.projects.find((group) => group.path === "/a")?.sessions.map((s) => s.id), ["parent", "orphan-fork"]);
	assert.deepEqual(nested.spawned.parent.map((s) => s.id), ["child", "fork"]);
});

test("a child whose parent is not in the same list keeps a row of its own", () => {
	const nested = nestSpawned(
		groupSessions(
			[session({ id: "parent", createdAt: 1 }), session({ id: "pinned-child", createdAt: 2, ...from("parent") }), session({ id: "orphan", createdAt: 3, ...from("archived-parent") })],
			projects,
			"",
			[],
			["pinned-child"],
		),
	);
	assert.deepEqual(nested.pinnedSessions.map((s) => s.id), ["pinned-child"]);
	assert.deepEqual(nested.projects.find((group) => group.path === "/a")?.sessions.map((s) => s.id), ["parent", "orphan"]);
	assert.deepEqual(nested.spawned, {});
});

test("two records naming each other cannot both vanish", () => {
	const nested = nestSpawned(groupSessions([session({ id: "a", createdAt: 1, ...from("b") }), session({ id: "b", createdAt: 1, ...from("a") })], projects, ""));
	assert.deepEqual(nested.projects.find((group) => group.path === "/a")?.sessions.map((s) => s.id).sort(), ["a", "b"]);
});
