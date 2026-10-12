/**
 * MCP 远程服务器的 OAuth：登录走完整条规范的路、令牌只进 vault、过期自动刷新、刷新不了就回到
 * 「需要登录」、要升 scope 时不拿刷新令牌糊弄、几台服务器互不相干。
 *
 * 对着一台真的 SDK MCP 服务器加一台手写的授权服务器（`mcp-oauth-fixture.ts`），浏览器那一下由
 * `browser()` 代替：打开授权页、跟着跳回本机回调。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, beforeEach, test } from "node:test";
import { McpManager } from "../src/mcp/client.ts";
import { forgetTokens, readRecord, signedIn, updateRecord, usesOAuth } from "../src/mcp/oauth.ts";
import { loginMcpServer } from "../src/mcp/oauth-login.ts";
import { putSecrets, resetVault, secret } from "../src/config/vault.ts";
import { DEFAULT_SETTINGS, saveSettings } from "../src/config/settings.ts";
import type { McpHttpServer } from "../src/mcp/types.ts";
import { browser, startOAuthFixture, type OAuthFixture } from "./mcp-oauth-fixture.ts";
import { startMcpHttpFixture } from "./mcp-http-fixture.ts";

const previous = { home: process.env.PLUME_HOME, userProfile: process.env.USERPROFILE };
const homes: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
	const home = await mkdtemp(join(tmpdir(), "plume-mcp-oauth-"));
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

async function oauthServer(options: Parameters<typeof startOAuthFixture>[0] = {}, id = "secure"): Promise<{ fixture: OAuthFixture; server: McpHttpServer }> {
	const fixture = await startOAuthFixture(options);
	cleanups.push(() => fixture.close());
	return { fixture, server: { id, name: id === "secure" ? "Secure" : id, transport: "http", url: fixture.url, enabled: true } };
}

async function connect(...servers: McpHttpServer[]) {
	const manager = new McpManager({ timeoutMs: 5000 });
	cleanups.push(() => manager.dispose());
	return { manager, statuses: await manager.connectAll(servers) };
}

const opened: string[] = [];
const login = (server: McpHttpServer) =>
	loginMcpServer(server, {
		open: async (url) => {
			opened.push(url);
			await browser(url);
		},
		timeoutMs: 5000,
	});

test("只有远程、没自己配 Authorization 的服务器挂 OAuth", () => {
	assert.equal(usesOAuth({ id: "a", name: "a", transport: "stdio", command: "x", enabled: true }), false);
	assert.equal(usesOAuth({ id: "a", name: "a", transport: "http", url: "https://x", enabled: true }), true);
	assert.equal(usesOAuth({ id: "a", name: "a", transport: "sse", url: "https://x", headers: { authorization: "Bearer k" }, enabled: true }), false);
});

test("没登录过：后台连接说「需要登录」，而且不在后台动态注册", async () => {
	const { fixture, server } = await oauthServer();
	const { statuses } = await connect(server);
	assert.equal(statuses[0]?.state, "needs-login");
	assert.match(statuses[0]?.error ?? "", /需要登录.*设置 → MCP/);
	assert.equal(fixture.stats.registrations, 0, "注册属于登录，后台不做");
});

test("登录：401 里的资源元数据 → 授权服务器元数据 → 注册 → PKCE 授权码，带 resource 和 state；令牌只进 vault", async () => {
	const { fixture, server } = await oauthServer();
	await login(server);
	assert.equal(fixture.stats.registrations, 1);
	assert.equal(fixture.stats.codeExchanges, 1);
	const [authorization] = fixture.stats.authorizations;
	assert.equal(authorization?.resource, fixture.url, "RFC 8707 的 resource 指向这台 MCP 服务器");
	assert.equal(authorization?.scope, "mcp", "scope 取自 401 的 WWW-Authenticate");
	assert.ok(authorization?.state && authorization.state.length >= 20);
	assert.ok(opened.at(-1)?.startsWith(`${fixture.origin}/auth/authorize?`));

	const record = await readRecord(server);
	assert.ok(record.tokens?.access_token && record.tokens.refresh_token);
	const onDisk = await readFile(join(process.env.PLUME_HOME!, "credentials.json"), "utf8");
	assert.ok(!onDisk.includes(record.tokens.access_token) && !onDisk.includes(record.tokens.refresh_token!), "vault 里是密文");
	assert.match(onDisk, /"mcp-oauth:secure": "v1:/);

	const { manager, statuses } = await connect(server);
	assert.equal(statuses[0]?.state, "connected");
	assert.equal(statuses[0]?.signedIn, true);
	assert.equal(fixture.stats.bearers.at(-1), record.tokens.access_token);
	const result = manager.allTools().find((tool) => tool.name === "mcp__secure__ask");
	assert.ok(result, "带着令牌列出了工具");
});

test("401 不说资源元数据在哪，也能从 well-known 找到", async () => {
	const { fixture, server } = await oauthServer({ advertise: false });
	await login(server);
	assert.equal(fixture.stats.authorizations[0]?.resource, fixture.url);
	assert.equal(await signedIn(server), true);
});

test("退出登录再登录：沿用注册时的回调端口和客户端，不再注册", async () => {
	const { fixture, server } = await oauthServer();
	await login(server);
	const first = await readRecord(server);
	await forgetTokens(server);
	assert.equal(await signedIn(server), false);
	assert.equal((await connect(server)).statuses[0]?.state, "needs-login", "退出以后后台连接要登录");
	assert.ok((await readRecord(server)).client, "注册信息留着");
	await login(server);
	assert.equal(fixture.stats.registrations, 1);
	assert.equal(fixture.stats.authorizations[1]?.clientId, fixture.stats.authorizations[0]?.clientId);
	assert.equal((await readRecord(server)).client?.client_id, first.client?.client_id);
});

test("访问令牌过期：撞上 401 自动用刷新令牌换新的，新令牌存回 vault", async () => {
	const { fixture, server } = await oauthServer();
	await login(server);
	const before = (await readRecord(server)).tokens!;
	fixture.expireAccess();
	const { statuses } = await connect(server);
	assert.equal(statuses[0]?.state, "connected");
	assert.equal(fixture.stats.refreshes, 1);
	const now = (await readRecord(server)).tokens!;
	assert.notEqual(now.access_token, before.access_token);
	assert.notEqual(now.refresh_token, before.refresh_token, "轮换来的刷新令牌也存下了");
	resetVault();
	assert.equal((await readRecord(server)).tokens?.access_token, now.access_token, "落了盘，不只在内存里");
});

test("连接中途令牌过期，调工具时刷新，工具照常返回", async () => {
	const { fixture, server } = await oauthServer();
	await login(server);
	const { manager } = await connect(server);
	fixture.expireAccess();
	// `ask` 工具会反问用户；这个管理器没法问人，服务器拿到 decline，工具照样返回。
	const result = await manager.allTools().find((tool) => tool.name === "mcp__secure__ask")!.execute({}, { cwd: "/tmp", sessionId: "s" });
	assert.equal(result.isError, false);
	assert.equal(fixture.stats.refreshes, 1);
});

test("刷新被拒：回到「需要登录」，令牌清掉，不重新注册", async () => {
	const { fixture, server } = await oauthServer();
	await login(server);
	fixture.expireAccess();
	fixture.revokeRefresh();
	const { statuses } = await connect(server);
	assert.equal(statuses[0]?.state, "needs-login");
	assert.match(statuses[0]?.error ?? "", /登录已失效/);
	assert.equal(fixture.stats.refreshRejected, 1);
	assert.equal(fixture.stats.registrations, 1);
	assert.equal((await readRecord(server)).tokens, undefined);
	assert.equal(await signedIn(server), false);
});

test("403 insufficient_scope：不拿刷新令牌糊弄，记下要的 scope，下次登录一并申请", async () => {
	const { fixture, server } = await oauthServer({ toolScope: "write" });
	await login(server);
	const { manager } = await connect(server);
	const result = await manager.allTools().find((tool) => tool.name === "mcp__secure__ask")!.execute({}, { cwd: "/tmp", sessionId: "s" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /需要更大的权限/);
	assert.equal(fixture.stats.refreshes, 0, "刷新换不来更大的 scope");
	assert.equal((await readRecord(server)).stepUpScope, "mcp write");
	assert.equal(await signedIn(server), false, "欠着一次升级，算需要登录");
	assert.equal((await connect(server)).statuses[0]?.state, "connected", "已有的权限照样能连上、列工具");

	await login(server);
	assert.equal(fixture.stats.authorizations.at(-1)?.scope, "mcp write");
	assert.equal((await readRecord(server)).stepUpScope, undefined);
	const again = await connect(server);
	const retried = await again.manager.allTools().find((tool) => tool.name === "mcp__secure__ask")!.execute({}, { cwd: "/tmp", sessionId: "s" });
	assert.equal(retried.isError, false);
});

test("几台服务器互不相干：一台登录了、一台没登录、一台不用登录", async () => {
	const a = await oauthServer({}, "alpha");
	const b = await oauthServer({}, "beta");
	const plain = await startMcpHttpFixture();
	cleanups.push(() => plain.close());
	await login(a.server);
	const { statuses } = await connect(a.server, b.server, { id: "plain", name: "Plain", transport: "http", url: plain.url, enabled: true });
	assert.deepEqual(
		statuses.map((status) => [status.id, status.state, status.signedIn ?? false]),
		[
			["alpha", "connected", true],
			["beta", "needs-login", false],
			["plain", "connected", false],
		],
	);
	assert.equal(b.fixture.stats.registrations, 0);
});

test("要 401 却没有任何 OAuth 元数据的服务器：是连接失败，不说成「需要登录」", async () => {
	const { server } = await oauthServer({ noMetadata: true });
	const { statuses } = await connect(server);
	assert.equal(statuses[0]?.state, "failed");
	assert.match(statuses[0]?.error ?? "", /没有提供 OAuth 元数据/);
});

test("服务器改了地址：旧地址的令牌不拿去用", async () => {
	const { server } = await oauthServer();
	await login(server);
	assert.equal(await signedIn({ ...server, url: `${server.url}/v2` }), false);
});

test("删掉服务器，它的登录记录跟着从 vault 里清掉", async () => {
	const { server } = await oauthServer();
	await login(server);
	await saveSettings({ ...DEFAULT_SETTINGS, mcpServers: [server] });
	assert.ok(await secret("mcp-oauth:secure"), "服务器还在，记录留着");
	await saveSettings({ ...DEFAULT_SETTINGS, mcpServers: [] });
	assert.equal(await secret("mcp-oauth:secure"), null);
});

test("vault 的写一个接一个：同时写不同的条目，一条也不丢", async () => {
	await Promise.all(Array.from({ length: 12 }, (_, i) => putSecrets({ [`k${i}`]: `v${i}` })));
	await Promise.all(Array.from({ length: 6 }, (_, i) => updateRecord({ id: `s${i}`, name: "s", transport: "http", url: "http://x", enabled: true }, (record) => ({ ...record, stepUpScope: `x${i}` }))));
	resetVault();
	for (let i = 0; i < 12; i++) assert.equal(await secret(`k${i}`), `v${i}`);
	for (let i = 0; i < 6; i++) assert.match((await secret(`mcp-oauth:s${i}`)) ?? "", new RegExp(`x${i}`));
});

test("登录点了两下：只开一次浏览器", async () => {
	const { fixture, server } = await oauthServer();
	const count = opened.length;
	await Promise.all([login(server), login(server)]);
	assert.equal(opened.length - count, 1);
	assert.equal(fixture.stats.codeExchanges, 1);
	await delay(0);
});
