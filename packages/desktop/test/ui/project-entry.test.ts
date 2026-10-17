/**
 * What 创建项目 and 编辑项目 write, and what opening a project must not overwrite.
 *
 * The second half is the older bug and the reason the first half needed a guard at all. Opening a
 * project rebuilt its entry from `workspaceInfo`, whose `name` is the directory's `basename` — so
 * everything the user had said about the project was thrown away on the next switch away and back.
 * A rename reverted silently; the source folders would have gone the same way, which would have
 * made the dialog that sets them a form whose answers do not survive the afternoon.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "@plume/core";
import type { SessionSnapshot, WorkspaceInfo } from "../../electron/ipc-types.ts";
import { useApp } from "../../src/store/index.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };

function workspace(path: string): WorkspaceInfo {
	// `name` is the basename, exactly as `workspaceInfo` answers — that is the whole point here.
	return { path, name: path.split("/").pop() ?? path, isGitRepo: false, branch: null };
}

function snapshot(id: string, cwd: string): SessionSnapshot {
	return {
		meta: { id, title: id, projectId: cwd, projectName: cwd, cwd, createdAt: 1, updatedAt: 2, modelId: "", messageCount: 1, seq: 2, usage },
		messages: [],
		running: false,
		pendingApprovals: [],
	};
}

let saves: Settings[];

function projects() {
	return useApp.getState().settings?.projects ?? [];
}

beforeEach(() => {
	saves = [];
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects: [] },
		workspace: null,
		scratchCwd: null,
		scratchRoots: [],
		selectionEpoch: 0,
		activeSessionId: null,
		meta: null,
		messages: [],
		sessions: [],
		sessionCache: {},
		toolRuns: {},
		running: false,
		todos: [],
		compactions: [],
		commandRuns: [],
		approvals: [],
		loadingSession: false,
		pendingUserMessage: null,
		activity: {},
		turns: {},
		carried: {},
		notices: [],
		capabilities: null,
		view: "chat",
		stopped: null,
		retrying: null,
		turnStartedAt: null,
		turnTokens: 0,
	});
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			workspace: { info: async (path: string) => workspace(path) },
			git: { generalScratch: async () => "/scratch" },
			settings: {
				save: async (settings: Settings) => {
					saves.push(settings);
					// The real one broadcasts the saved settings back; the store reads them again.
					useApp.setState({ settings });
					return settings;
				},
			},
			sessions: {
				create: async (cwd: string) => snapshot("new", cwd),
				capabilities: async () => null,
				transcript: async (id: string) => snapshot(id, useApp.getState().sessions.find((session) => session.id === id)?.cwd ?? "/app"),
			},
			subAgents: { list: async () => [] },
			agent: { prompt: async (id: string) => snapshot(id, "/app").meta },
		},
	});
});

// ---------------------------------------------------------------- 创建项目

test("创建项目 keeps the name that was typed, not the folder's", async () => {
	await useApp.getState().createProject("后端服务", ["/Users/x/api"]);
	assert.deepEqual(
		projects().map((p) => [p.name, p.path]),
		[["后端服务", "/Users/x/api"]],
	);
});

test("an unnamed project falls back to the folder's name", async () => {
	await useApp.getState().createProject("   ", ["/Users/x/api"]);
	assert.equal(projects()[0].name, "api");
});

test("the first folder is the project's path; the rest are its other source folders", async () => {
	await useApp.getState().createProject("双仓", ["/Users/x/app", "/Users/x/api"]);
	const [entry] = projects();
	assert.equal(entry.path, "/Users/x/app");
	assert.deepEqual(entry.folders, ["/Users/x/app", "/Users/x/api"]);
});

/*
 * One folder writes no `folders` at all.
 *
 * Every settings file in existence says nothing here and means `[path]`. A one-folder project
 * created today has to be indistinguishable from one created last year, or the field starts
 * carrying information it does not have.
 */
test("a one-folder project writes no folders field", async () => {
	await useApp.getState().createProject("单仓", ["/Users/x/app"]);
	assert.equal(projects()[0].folders, undefined);
});

/*
 * 新建永远是新建。
 *
 * 之前按主文件夹去找已有条目，找到就改它：用项目 A 的文件夹「新建项目 B」，结果是 A 被改名成 B、
 * 文件夹也被换掉，A 就没了。项目是一件事，同一个检出可以同时在两件事里。
 */
test("pointing 创建项目 at a folder already on the list adds a second project and leaves the first alone", async () => {
	await useApp.getState().createProject("第一次", ["/Users/x/app"]);
	await useApp.getState().createProject("第二次", ["/Users/x/app", "/Users/x/api"]);
	assert.deepEqual(
		projects().map((p) => [p.name, p.path, p.folders]),
		[
			["第二次", "/Users/x/app", ["/Users/x/app", "/Users/x/api"]],
			["第一次", "/Users/x/app", undefined],
		],
	);
	assert.notEqual(projects()[0].id, projects()[1].id);
});

test("two projects may share a name", async () => {
	await useApp.getState().createProject("app", ["/Users/x/a/app"]);
	await useApp.getState().createProject("app", ["/Users/x/b/app"]);
	assert.deepEqual(projects().map((p) => p.name), ["app", "app"]);
});

test("a new project opens as itself, not as the project that already had its folder", async () => {
	await useApp.getState().createProject("第一次", ["/Users/x/app"]);
	await useApp.getState().createProject("第二次", ["/Users/x/app"]);
	const [second] = projects();
	assert.equal(useApp.getState().workspace?.name, "第二次");
	assert.equal(useApp.getState().workspace?.projectId, second.id);
});

// A refresh brings git's news; the folder it reads only knows its basename, and which project is open is not git's to say.
test("refreshing the open workspace keeps the project it was opened as", async () => {
	await useApp.getState().createProject("第一次", ["/Users/x/app"]);
	await useApp.getState().createProject("第二次", ["/Users/x/app"]);
	const [second] = projects();
	await useApp.getState().refreshWorkspace();
	assert.equal(useApp.getState().workspace?.name, "第二次");
	assert.equal(useApp.getState().workspace?.projectId, second.id);
});

test("a project with no folders is not a project", async () => {
	await useApp.getState().createProject("空的", []);
	assert.deepEqual(projects(), []);
});

// ---------------------------------------------------------------- 编辑项目

test("编辑项目 renames without touching the folders", async () => {
	await useApp.getState().createProject("旧名", ["/Users/x/app", "/Users/x/api"]);
	await useApp.getState().updateProject(projects()[0].id, { name: "新名" });
	assert.equal(projects()[0].name, "新名");
	assert.deepEqual(projects()[0].folders, ["/Users/x/app", "/Users/x/api"]);
});

test("an empty name leaves the old one rather than clearing it", async () => {
	await useApp.getState().createProject("旧名", ["/Users/x/app"]);
	await useApp.getState().updateProject(projects()[0].id, { name: "  " });
	assert.equal(projects()[0].name, "旧名");
});

test("taking the last extra folder out puts the entry back to having none", async () => {
	await useApp.getState().createProject("双仓", ["/Users/x/app", "/Users/x/api"]);
	await useApp.getState().updateProject(projects()[0].id, { folders: ["/Users/x/app"] });
	assert.equal(projects()[0].folders, undefined);
});

test("the main folder stays first however the dialog hands the list back", async () => {
	await useApp.getState().createProject("双仓", ["/Users/x/app"]);
	await useApp.getState().updateProject(projects()[0].id, { folders: ["/Users/x/api", "/Users/x/app"] });
	assert.deepEqual(projects()[0].folders, ["/Users/x/app", "/Users/x/api"]);
});

test("编辑项目 changes only the project it was opened on, not another on the same folder", async () => {
	await useApp.getState().createProject("甲", ["/Users/x/app"]);
	await useApp.getState().createProject("乙", ["/Users/x/app"]);
	const second = projects().find((p) => p.name === "乙")!;
	await useApp.getState().updateProject(second.id, { name: "丙" });
	assert.deepEqual(projects().map((p) => p.name).sort(), ["丙", "甲"]);
});

// ---------------------------------------------------------------- 移除项目

test("移除 takes out that one project, even when another shares its folder", async () => {
	await useApp.getState().createProject("甲", ["/Users/x/app"]);
	await useApp.getState().createProject("乙", ["/Users/x/app"]);
	const second = projects().find((p) => p.name === "乙")!;
	await useApp.getState().removeProject(second.id);
	assert.deepEqual(projects().map((p) => p.name), ["甲"]);
});

// ---------------------------------------------------------------- 打开项目

test("opening a project keeps the name it was given and the folders it was configured with", async () => {
	await useApp.getState().createProject("我的项目", ["/Users/x/app", "/Users/x/api"]);
	await useApp.getState().openWorkspace("/Users/x/app");
	const [entry] = projects();
	assert.equal(entry.name, "我的项目", "opening reverted the name to the directory's basename");
	assert.deepEqual(entry.folders, ["/Users/x/app", "/Users/x/api"], "opening dropped the extra source folders");
});

/*
 * And the header has to say the same thing the sidebar does.
 *
 * `workspace` is what the window title, the composer's chip and the git panel read, and it comes
 * from `workspaceInfo` — which knows the directory and nothing about the project. A rename that
 * only reached settings showed up in one list and nowhere else.
 */
test("the open workspace carries the project's name, not the directory's", async () => {
	await useApp.getState().createProject("我的项目", ["/Users/x/app"]);
	const [project] = projects();
	await useApp.getState().openWorkspace("/Users/x/app", project.id);
	assert.equal(useApp.getState().workspace?.name, "我的项目");
});

/*
 * 先有项目，再有文件夹。
 *
 * 打开过的文件夹都会被登记成一个以它命名的项目，于是「项目」成了「去过的地方」。现在单独打开文件夹
 * 什么也不写；哪怕那个文件夹正是某个项目的，没选那个项目，就不在那个项目里。
 */
test("a folder opened on its own opens under its own name and is not made a project", async () => {
	await useApp.getState().openWorkspace("/Users/x/somewhere");
	assert.equal(useApp.getState().workspace?.name, "somewhere");
	assert.equal(useApp.getState().workspace?.projectId, undefined);
	assert.deepEqual(projects(), []);
});

test("a project's folder opened on its own is not that project", async () => {
	await useApp.getState().createProject("我的项目", ["/Users/x/app"]);
	await useApp.getState().openWorkspace("/Users/x/app");
	assert.equal(useApp.getState().workspace?.name, "app");
	assert.equal(useApp.getState().workspace?.projectId, undefined);
	assert.equal(projects().length, 1);
});

// ---------------------------------------------------------------- 不在项目里的对话

/*
 * 「从项目中移除」只是不再属于哪个项目。
 *
 * 以前要挪进「不在项目中工作」的临时目录，因为侧栏按文件夹分组，留在原地就会再长出一个项目来。
 * 现在只认对话记下的项目，原地不动就够了；挪走反倒让它离开了自己的仓库。
 */
test("taking a conversation out of its project leaves it running in its folder", async () => {
	await useApp.getState().createProject("甲", ["/Users/x/app"]);
	const [project] = projects();
	const session = { ...snapshot("s", "/Users/x/app").meta, project: project.id };
	useApp.setState({ sessions: [session] });
	const moves: unknown[][] = [];
	(window.plume.sessions as unknown as { move: unknown }).move = async (id: string, cwd: string, name: string, to?: string) => {
		moves.push([cwd, name, to]);
		const { project: _, ...rest } = session;
		return { ok: true, meta: { ...rest, cwd, projectName: name, ...(to ? { project: to } : {}) } };
	};
	await useApp.getState().moveSessionProject(session, "");
	assert.deepEqual(moves, [["/Users/x/app", session.projectName, undefined]]);
	const after = useApp.getState().sessions[0];
	assert.equal(after.cwd, "/Users/x/app");
	assert.equal(after.project, undefined);
});

/*
 * 点进同一个文件夹里一条不在项目中的对话，工作区就不再挂着那个项目。
 *
 * 留着的话，从这里开的下一条对话会被记进那个项目——而它只是在同一个文件夹里，不在那个项目里。
 */
test("opening a conversation in no project, on a project's folder, leaves the workspace in no project", async () => {
	await useApp.getState().createProject("甲", ["/Users/x/app"]);
	assert.ok(useApp.getState().workspace?.projectId);
	const loose = snapshot("loose", "/Users/x/app").meta;
	useApp.setState({ sessions: [loose] });
	await useApp.getState().openSession(loose);
	assert.equal(useApp.getState().workspace?.path, "/Users/x/app");
	assert.equal(useApp.getState().workspace?.projectId, undefined);
	assert.equal(useApp.getState().workspace?.name, loose.projectName);
});
