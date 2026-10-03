/**
 * `.plume/config.json` 到底有没有被读。
 *
 * 分层合并本身有一整份测试，而那份测试测的是「如果有人调用它，它会合并对」。产品里没有人调用
 * 它——`loadProjectLayer`、`mergeLayer`、`resolveLayers` 在 `packages/` 里的引用全部来自
 * 测试文件。「A 项目用便宜模型加严格审批、B 项目用强模型加宽松审批」在这个分支上一直是
 * 一段注释。
 *
 * 所以这里从 `AgentSession` 这一头测：写一个真的 `.plume/config.json`，起一个真的会话，
 * 问它现在用的是什么。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgentSession } from "../src/runtime/session.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import type { SessionMeta } from "../src/session/store.ts";
import type { SessionStorage } from "../src/session/storage.ts";

let home: string;
let root: string;

const META = { id: "s1", projectId: "p", cwd: "", modelId: "m", title: "", createdAt: 0, updatedAt: 0 } as unknown as SessionMeta;
const STORE = { append: async (meta: SessionMeta) => meta, create: async () => META } as unknown as SessionStorage;

const GLOBAL: Settings = {
	...DEFAULT_SETTINGS,
	defaultModelId: "global/strong",
	maxConcurrentSubAgents: 4,
	permissionMode: "full",
} as Settings;

/** 起一个会话，返回它最终在用的设置和它说过的话。 */
async function sessionIn(cwd: string) {
	const events: AgentEvent[] = [];
	const session = new AgentSession({
		cwd,
		settings: GLOBAL,
		store: STORE,
		meta: { ...META, cwd },
		emit: async (event) => void events.push(event),
	});
	await session.initialize();
	// 会话把最终设置交给能力层和每一轮，所以从它自己的报告里读回来是最贴近产品的问法。
	const status = await session.status();
	return { session, events, status };
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-cfg-home-"));
	root = await mkdtemp(join(tmpdir(), "ly-cfg-"));
	process.env.PLUME_HOME = home;
});

after(async () => {
	delete process.env.PLUME_HOME;
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

async function project(name: string, config: unknown): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, ".plume"), { recursive: true });
	if (config !== undefined) await writeFile(join(dir, ".plume", "config.json"), JSON.stringify(config), "utf8");
	return dir;
}

test("项目里的 .plume/config.json 真的生效", async () => {
	/*
	 * 这条以前必然失败。分层模块在，测试在，而 `AgentSession` 从来没读过那个文件——
	 * 每个项目拿到的都是同一份全局设置。
	 */
	const cwd = await project("cheap", { defaultModelId: "project/cheap", maxConcurrentSubAgents: 1 });
	const { session } = await sessionIn(cwd);

	// `status()` 报的是会话自己在用的那份，不是应用的那份。
	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "project/cheap");
	assert.equal(used.maxConcurrentSubAgents, 1);
});

test("没有配置文件的项目，跟以前一模一样", async () => {
	const cwd = await project("plain", undefined);
	const { session } = await sessionIn(cwd);
	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "global/strong");
});

test("项目文件带凭证会被拒，而且说出来", async () => {
	/*
	 * 这个文件是要提交进仓库的——那正是它的用途。落在里面的凭证就是已公开的凭证，而放进去的人
	 * 通常是最后一个知道的。安静地忽略掉，写的人会以为它生效了。
	 */
	const cwd = await project("leaky", {
		defaultModelId: "project/cheap",
		providers: [{ id: "x", apiKey: "sk-真的密钥" }],
		mcpServers: [{ id: "m", command: "curl" }],
	});
	const { session, events } = await sessionIn(cwd);

	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "project/cheap", "允许的那部分照常生效");
	assert.deepEqual(used.providers, GLOBAL.providers, "供应商还是全局那份");

	const warned = events.find((e) => e.type === "notice" && e.message.includes("被忽略"));
	assert.ok(warned, `要说出来，实际说的是：${events.map((e) => (e.type === "notice" ? e.message : e.type)).join(" | ")}`);
	assert.match((warned as { message: string }).message, /providers/);
	assert.match((warned as { message: string }).message, /mcpServers/);
});

test("坏掉的 JSON 不会让会话起不来", async () => {
	/*
	 * 有人正在改这个文件、多打了一个逗号——他该拿到的是全局设置加一句话，
	 * 不是一个打不开的窗口。
	 */
	const dir = join(root, "broken");
	await mkdir(join(dir, ".plume"), { recursive: true });
	await writeFile(join(dir, ".plume", "config.json"), "{ oops,", "utf8");

	const { session, events } = await sessionIn(dir);
	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "global/strong");
	assert.ok(events.some((e) => e.type === "notice" && e.message.includes("不是合法的 JSON")));
});

test("改全局设置不会把项目层默默清掉", async () => {
	/*
	 * `updateSettings` 收到的是全局那一份。不重新叠，那么在设置页动任何一项——改个主题都算——
	 * 都会让这个会话悄悄退回全局配置，而屏幕上没有任何东西说这件事。
	 */
	const cwd = await project("sticky", { defaultModelId: "project/cheap" });
	const { session } = await sessionIn(cwd);

	session.updateSettings({ ...GLOBAL, autoSummarizeTitle: false });
	// `updateSettings` 是同步的，项目层在它之后自己叠回来。
	await new Promise((resolve) => setTimeout(resolve, 50));

	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "project/cheap", "项目的模型还在");
	assert.equal(used.autoSummarizeTitle, false, "全局的新值也进来了");
});

test("the project layer is still on the moment updateSettings returns", async () => {
	// It used to drop to global settings until the re-read landed: a stricter project approval
	// mode was off for the length of a disk read.
	const cwd = await project("no-gap", { defaultModelId: "project/cheap", permissionMode: "ask" });
	const { session } = await sessionIn(cwd);

	session.updateSettings({ ...GLOBAL, autoSummarizeTitle: false });

	const used = (session as unknown as { settings: Settings }).settings;
	assert.equal(used.defaultModelId, "project/cheap");
	assert.equal(used.permissionMode, "ask");
	assert.equal(used.autoSummarizeTitle, false);
});

test("a slower, older read of the project layer does not land over a newer one", { skip: process.platform === "win32" && "needs a FIFO" }, async () => {
	/*
	 * The first read is held open on a FIFO until the second has landed, then let go with stale
	 * content — the order a slow disk can produce, made deterministic.
	 */
	const cwd = await project("race", { defaultModelId: "project/v1" });
	const { session } = await sessionIn(cwd);
	const file = join(cwd, ".plume", "config.json");
	const handle = join(cwd, "held-fifo");
	await rm(file);
	execFileSync("mkfifo", [file]);
	await link(file, handle);
	const used = () => (session as unknown as { settings: Settings }).settings;

	session.updateSettings({ ...GLOBAL, maxConcurrentSubAgents: 2 });
	// Let the first read open the FIFO, where it blocks waiting for a writer.
	await new Promise((resolve) => setTimeout(resolve, 100));

	const fresh = join(cwd, "fresh.json");
	await writeFile(fresh, JSON.stringify({ defaultModelId: "project/v2" }), "utf8");
	await rename(fresh, file);
	session.updateSettings({ ...GLOBAL, maxConcurrentSubAgents: 3 });
	for (let i = 0; i < 100 && used().defaultModelId !== "project/v2"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(used().defaultModelId, "project/v2", "the second read landed");

	await writeFile(handle, JSON.stringify({ defaultModelId: "project/stale" }), "utf8");
	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.equal(used().defaultModelId, "project/v2", "the stale read was discarded");
	assert.equal(used().maxConcurrentSubAgents, 3);
});
