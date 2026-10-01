/**
 * 按时间成片地删会话。
 *
 * 这是这个应用里最不能错的一个动作：没有回收站，删掉的是聊天记录本身，而「少删了一条」和「多删
 * 了一条」的代价差着一个量级。所以这里问的全是边界——两头含不含当天、正在跑的那条有没有留下、
 * 释放量是不是删之前量的。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SessionMeta, SessionStorage } from "@plume/core";
import { clearSessions, storageUse, withinRange } from "../electron/session-cleanup.ts";

let home = "";
let index: SessionMeta[] = [];
let sizes: Record<string, number> = {};

function meta(id: string, updatedAt: number): SessionMeta {
	return {
		id,
		title: id,
		cwd: "/tmp/x",
		projectId: "proj-a",
		projectName: "x",
		createdAt: updatedAt,
		updatedAt,
		modelId: "relay/m",
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		seq: 1,
	};
}

/** 只实现这两个函数真正会碰的那几个方法；别的被调到就是这些测试问错了问题。 */
function fakeStore(): SessionStorage {
	return {
		listSessions: async () => index,
		sizes: async () => ({ ...sizes }),
		deleteMany: async (ids: string[]) => {
			const gone = new Set(ids);
			for (const id of ids) delete sizes[id];
			index = index.filter((each) => !gone.has(each.id));
		},
	} as unknown as SessionStorage;
}

/** 一条会话：列表里一行，库里一段有大小的记录。 */
function seed(id: string, updatedAt: number, bytes = 1024): void {
	index.push(meta(id, updatedAt));
	sizes[id] = bytes;
}

const at = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0).getTime();

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-cleanup-"));
	index = [];
	sizes = {};
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

describe("withinRange", () => {
	it("两头都含当天", () => {
		const range = { from: "2026-09-01", to: "2026-09-10" };
		assert.equal(withinRange({ updatedAt: at(9, 1) }, range), true);
		assert.equal(withinRange({ updatedAt: at(9, 10) }, range), true);
		assert.equal(withinRange({ updatedAt: at(8, 31) }, range), false);
		assert.equal(withinRange({ updatedAt: at(9, 11) }, range), false);
	});

	it("两头都空就是全部——这是「一键清空」，不是一段退化的区间", () => {
		assert.equal(withinRange({ updatedAt: at(1, 1) }, { from: null, to: null }), true);
	});

	it("当天深夜的会话属于那一天，不是第二天", () => {
		// 本地日期，和用量页同一个口径。按 UTC 算的话这条会跑到 9-11 去，于是「删到 9-10」会漏掉它。
		const late = new Date(2026, 8, 10, 23, 30).getTime();
		assert.equal(withinRange({ updatedAt: late }, { from: null, to: "2026-09-10" }), true);
	});
});

describe("storageUse", () => {
	it("没有会话是零，不是崩", async () => {
		const use = await storageUse(fakeStore());
		assert.deepEqual(use, { bytes: 0, sessions: 0, earliest: null, latest: null, days: [] });
	});

	it("字节是记录的大小，条数和头尾日期来自会话列表", async () => {
		seed("s1", at(8, 11), 2048);
		seed("s2", at(9, 21), 1024);
		const use = await storageUse(fakeStore());
		assert.equal(use.bytes, 3072);
		assert.equal(use.sessions, 2);
		assert.equal(use.earliest, "2026-08-11");
		assert.equal(use.latest, "2026-09-21");
	});

	it("按天摊开，好让界面算得出「选了这一段会删掉什么」", async () => {
		// 少了这张表，确认框只能拿总数去问「删除全部 303 条？」——而实际落在范围里的可能只有一条。
		seed("a", at(9, 5), 1024);
		seed("b", at(9, 5), 2048);
		seed("c", at(9, 21), 512);
		const use = await storageUse(fakeStore());
		assert.deepEqual(use.days, [
			{ day: "2026-09-05", sessions: 2, bytes: 3072 },
			{ day: "2026-09-21", sessions: 1, bytes: 512 },
		]);
	});
});

describe("clearSessions", () => {
	/** 主进程那一侧：忙着的留下，其余删掉，报回删了哪些。 */
	const removeIdle = (busy: (id: string) => boolean) => async (ids: string[]) => {
		const taken = ids.filter((id) => !busy(id));
		await fakeStore().deleteMany(taken);
		return taken;
	};
	const never = removeIdle(() => false);

	it("只删落在这一段里的，别的一条不动", async () => {
		seed("old", at(8, 1));
		seed("mid", at(9, 5));
		seed("new", at(9, 21));

		const result = await clearSessions(fakeStore(), { from: "2026-09-01", to: "2026-09-10" }, never, home);
		assert.deepEqual(result, { removed: 1, freed: 1024, skipped: 0 });
		assert.deepEqual(index.map((each) => each.id).sort(), ["new", "old"]);
		assert.equal(sizes.mid, undefined, "记录也要真的没了");
	});

	it("两头都空就是全删", async () => {
		seed("a", at(8, 1));
		seed("b", at(9, 21));
		const result = await clearSessions(fakeStore(), { from: null, to: null }, never, home);
		assert.equal(result.removed, 2);
		assert.equal(index.length, 0);
	});

	it("正在跑的那条留下，并且要报出来", async () => {
		// 删一条正在执行工具调用的会话，省下的那几 KB 远不如它正在写的东西值钱。
		seed("running", at(9, 5));
		seed("idle", at(9, 6));

		const result = await clearSessions(fakeStore(), { from: null, to: null }, removeIdle((id) => id === "running"), home);
		assert.deepEqual(result, { removed: 1, freed: 1024, skipped: 1 });
		assert.deepEqual(index.map((each) => each.id), ["running"]);
	});

	it("一条都没匹配上时，删除动作根本不发生", async () => {
		seed("a", at(9, 21));
		const result = await clearSessions(fakeStore(), { from: "2020-01-01", to: "2020-12-31" }, never, home);
		assert.deepEqual(result, { removed: 0, freed: 0, skipped: 0 });
		assert.equal(index.length, 1);
	});

	it("释放量是删之前量的，不是删之后", async () => {
		// 删完再量得到的是一片零，界面上就会说「释放 0 KB」——看起来像什么都没发生。
		seed("a", at(9, 1), 4096);
		seed("b", at(9, 2), 2048);
		const result = await clearSessions(fakeStore(), { from: null, to: null }, never, home);
		assert.equal(result.freed, 6144);
	});

	it("会话写在项目外的东西跟着一起走", async () => {
		seed("a", at(9, 1));
		await mkdir(join(home, "previews", "a"), { recursive: true });
		await writeFile(join(home, "previews", "a", "index.html"), "<!doctype html>");

		await clearSessions(fakeStore(), { from: null, to: null }, never, home);
		await assert.rejects(stat(join(home, "previews", "a")), "预览目录是这条会话写的，它应该跟着没");
	});
});
