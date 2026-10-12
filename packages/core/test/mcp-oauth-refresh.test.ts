/**
 * OAuth 令牌的两件事：快过期时提前换（省掉一次 401），以及桌面端和命令行两个进程同时换同一张
 * 刷新令牌时不互相踢掉。
 *
 * 跨进程那条是真起两个子进程（`mcp-oauth-child.ts`）、对着一台会轮换刷新令牌、拒绝用过的旧令牌的
 * 授权服务器（`mcp-oauth-fixture.ts`）同时去换：没有锁时，后到的那个拿着刚作废的令牌换，换来
 * invalid_grant，SDK 据此把令牌清掉，那台服务器回到「需要登录」。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp/client.ts";
import { readRecord, updateRecord } from "../src/mcp/oauth.ts";
import { loginMcpServer } from "../src/mcp/oauth-login.ts";
import { resetVault, secret } from "../src/config/vault.ts";
import type { McpHttpServer } from "../src/mcp/types.ts";
import { browser, startOAuthFixture, type OAuthFixture } from "./mcp-oauth-fixture.ts";

const CHILD = fileURLToPath(new URL("./mcp-oauth-child.ts", import.meta.url));
const previous = { home: process.env.PLUME_HOME, userProfile: process.env.USERPROFILE };
const homes: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
	const home = await mkdtemp(join(tmpdir(), "plume-mcp-refresh-"));
	homes.push(home);
	process.env.PLUME_HOME = home;
	process.env.USERPROFILE = home;
	resetVault();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

after(async () => {
	process.env.PLUME_HOME = previous.home;
	process.env.USERPROFILE = previous.userProfile;
	if (previous.home === undefined) delete process.env.PLUME_HOME;
	if (previous.userProfile === undefined) delete process.env.USERPROFILE;
	resetVault();
	for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function signedInServer(ttlMs: number): Promise<{ fixture: OAuthFixture; server: McpHttpServer }> {
	const fixture = await startOAuthFixture({ ttlMs });
	cleanups.push(() => fixture.close());
	const server: McpHttpServer = { id: "secure", name: "Secure", transport: "http", url: fixture.url, enabled: true };
	await loginMcpServer(server, { open: browser, timeoutMs: 5000 });
	return { fixture, server };
}

function child(mode: string, arg: string, startAt: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[CHILD, mode, arg],
			{ env: { ...process.env, START_AT: String(startAt) }, timeout: 30_000 },
			(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
		);
	});
}

test("快过期的令牌在发请求之前就换掉：不带着它去撞一次 401", async () => {
	const { fixture, server } = await signedInServer(3_600_000);
	const record = await readRecord(server);
	const old = record.tokens!.access_token;
	assert.ok(record.expiresAt && Math.abs(record.expiresAt - (Date.now() + 3_600_000)) < 5000, "按 expires_in 记下了过期时间");
	// 还剩 20 秒：进了提前一分钟的窗口，第一次用它之前就该换。
	await updateRecord(server, (current) => ({ ...current, expiresAt: Date.now() + 20_000 }));
	const manager = new McpManager({ timeoutMs: 5000 });
	cleanups.push(() => manager.dispose());
	const [status] = await manager.connectAll([server]);
	assert.equal(status?.state, "connected");
	assert.equal(fixture.stats.refreshes, 1);
	assert.equal(fixture.stats.refreshRejected, 0);
	assert.ok(!fixture.stats.bearers.includes(old), "旧令牌一次也没发出去");
});

test("离过期还远的令牌不提前换；寿命比一分钟还短的，刚换来的那张也不算「快过期」", async () => {
	const { fixture, server } = await signedInServer(30_000);
	const manager = new McpManager({ timeoutMs: 5000 });
	cleanups.push(() => manager.dispose());
	await manager.connectAll([server]);
	assert.equal(fixture.stats.refreshes, 0);
});

test("两个进程同时换同一张刷新令牌：只换一次，两边拿到同一份新令牌，谁也没被踢回「需要登录」", async () => {
	const { fixture, server } = await signedInServer(3_600_000);
	// 让记着的过期时间落进提前刷新的窗口：两个进程第一次取令牌时都会去换。
	await updateRecord(server, (record) => ({ ...record, expiresAt: Date.now() + 10_000 }));
	const before = (await readRecord(server)).tokens!;
	const startAt = Date.now() + 1500;
	const [first, second] = await Promise.all([child("refresh", JSON.stringify(server), startAt), child("refresh", JSON.stringify(server), startAt)]);
	assert.equal(fixture.stats.refreshRejected, 0, "后到的那个拿着作废的刷新令牌去换了");
	assert.equal(fixture.stats.refreshes, 1);
	assert.notEqual(first, before.access_token);
	assert.equal(first, second);
	resetVault();
	const stored = (await readRecord(server)).tokens!;
	assert.equal(stored.access_token, first);
	assert.notEqual(stored.refresh_token, before.refresh_token);
});

test("两个进程同时写 vault：各写十五条，一条也不丢", async () => {
	const startAt = Date.now() + 1500;
	await Promise.all([child("vault", "desktop", startAt), child("vault", "cli", startAt)]);
	resetVault();
	for (const prefix of ["desktop", "cli"]) for (let i = 0; i < 15; i++) assert.equal(await secret(`${prefix}-${i}`), `value-${i}`, `${prefix}-${i}`);
});
