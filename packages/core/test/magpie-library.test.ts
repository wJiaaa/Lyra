import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/config/settings.ts";
import { magpieInstructions, withMagpieMcp } from "../src/config/magpie-library.ts";
import { putSecrets, resetVault, secret } from "../src/config/vault.ts";
import { McpManager } from "../src/mcp/client.ts";
import { MCP_OAUTH_PREFIX } from "../src/mcp/oauth.ts";
import { loadPromptContext } from "../src/runtime/prompt-context.ts";
import { collectSkills, loadCapabilities } from "../src/runtime/session-setup.ts";
import { startMcpHttpFixture } from "./mcp-http-fixture.ts";

let home: string;
const previous = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-magpie-library-"));
	process.env.PLUME_HOME = home;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	resetVault();
	await mkdir(join(home, "magpie"));
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetVault();
	await rm(home, { recursive: true, force: true });
});

const own = { id: "own", name: "自己的服务", transport: "stdio" as const, command: "unused", enabled: false };
async function writeMcp(mcpServers: unknown) {
	await writeFile(join(home, "magpie", "mcp.json"), JSON.stringify({ mcpServers }));
}

test("分发的技能经过现有发现流程，移除后不再列出", async () => {
	const dir = join(home, "skills", "magpie-test");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), "---\nname: magpie-test\ndescription: 测试 Magpie 分发的技能是否能被会话发现\n---\n共享技能正文。");
	assert.ok((await collectSkills(home, [])).skills.some((skill) => skill.name === "magpie-test"));
	await rm(dir, { recursive: true });
	assert.ok(!(await collectSkills(home, [])).skills.some((skill) => skill.name === "magpie-test"));
});

test("全局指令进入实际提示词，每轮更新、删除且不覆盖个人指令", async () => {
	const settings = { ...DEFAULT_SETTINGS, personalization: { customInstructions: "个人规则保留", enableMemory: false, enableProjectMemory: false } };
	const prompt = () => loadPromptContext({ cwd: home, settings, tools: [], skills: [], agents: [] });
	const path = join(home, "magpie", "AGENTS.md");
	await writeFile(path, "\uFEFF共享规则第一版");
	let result = await prompt();
	assert.match(result.systemPrompt, /共享规则第一版/);
	assert.match(result.systemPrompt, /个人规则保留/);
	await writeFile(path, "共享规则第二版");
	result = await prompt();
	assert.match(result.systemPrompt, /共享规则第二版/);
	assert.doesNotMatch(result.systemPrompt, /共享规则第一版/);
	await rm(path);
	result = await prompt();
	assert.doesNotMatch(result.systemPrompt, /共享规则第二版/);
	assert.match(result.systemPrompt, /个人规则保留/);
	await saveSettings(settings);
	assert.equal((await loadSettings()).personalization?.customInstructions, "个人规则保留");
});

test("MCP 三种传输和占位符正确转换，默认不额外信任工具", async () => {
	await writeMcp({
		local: { command: "node", args: ["server.js", "${TOKEN}"], env: { TOKEN: "${TOKEN}" } },
		remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
		events: { type: "sse", url: "https://example.invalid/sse", disabled: true },
	});
	const { mcpServers } = await withMagpieMcp({ mcpServers: [own] });
	assert.deepEqual(mcpServers.map((server) => server.transport), ["stdio", "stdio", "http", "sse"]);
	assert.deepEqual(mcpServers[1].env, { TOKEN: "${TOKEN}" });
	assert.equal(mcpServers[2].transport !== "stdio" && mcpServers[2].headers?.Authorization, "Bearer ${TOKEN}");
	assert.equal(mcpServers[3].enabled, false);
	assert.ok(mcpServers.slice(1).every((server) => server.managedBy === "magpie" && server.trustReadOnly !== true));
	assert.deepEqual((await withMagpieMcp({ mcpServers })).mcpServers, mcpServers);
});

test("保存不复制 Magpie 配置或密钥，保留 OAuth；撤回后只有自己的服务", async () => {
	await writeFile(join(home, "settings.json"), JSON.stringify({ mcpServers: [own] }));
	await writeMcp({ remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "test-secret" } } });
	const original = await readFile(join(home, "magpie", "mcp.json"), "utf8");
	const oauth = `${MCP_OAUTH_PREFIX}magpie__remote`;
	await putSecrets({ [oauth]: "test-oauth" });
	await saveSettings(await loadSettings());
	const persisted = await readFile(join(home, "settings.json"), "utf8");
	assert.deepEqual(JSON.parse(persisted).mcpServers, [own]);
	assert.ok(!persisted.includes("test-secret"));
	assert.equal(await secret(oauth), "test-oauth");
	assert.equal(await readFile(join(home, "magpie", "mcp.json"), "utf8"), original);
	await writeFile(join(home, "magpie", "mcp.json"), "{}");
	assert.deepEqual((await loadSettings()).mcpServers, [own]);
	await saveSettings(await loadSettings());
	assert.equal(await secret(oauth), null);
});

test("无效条目和 ID 冲突留诊断，不能覆盖自己的服务或泄露解析内容", async (t) => {
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => warnings.push(message));
	const collision = { ...own, id: "magpie__same" };
	await writeMcp({ same: { command: "node" }, bad: { type: "websocket", url: "wss://example.invalid" }, badType: { type: ["http"], url: "https://example.invalid" }, args: { command: "node", args: [42] }, good: { command: "node" } });
	assert.deepEqual((await withMagpieMcp({ mcpServers: [collision] })).mcpServers.map((server) => server.id), ["magpie__same", "magpie__good"]);
	assert.equal(warnings.length, 4);
	await writeFile(join(home, "magpie", "mcp.json"), '{"secret":"do-not-log",broken');
	assert.deepEqual((await withMagpieMcp({ mcpServers: [own] })).mcpServers, [own]);
	assert.ok(warnings.every((message) => !message.includes("do-not-log")));
	await writeFile(join(home, "magpie", "AGENTS.md"), "x".repeat(110 * 1024));
	assert.equal((await magpieInstructions()).length, 100 * 1024);
});

test("Magpie 分发的 MCP 经真实会话加载连接 HTTP 服务器并发现工具", async () => {
	const fixture = await startMcpHttpFixture();
	const mcp = new McpManager();
	try {
		await writeMcp({ shared: { type: "http", url: fixture.url } });
		await loadCapabilities(home, await loadSettings(), mcp, []);
		assert.equal(mcp.statuses()[0].state, "connected");
		assert.ok(mcp.statuses()[0].tools.some((tool) => tool.name === "mcp__magpie__shared__ask"));
		await writeMcp({});
		await loadCapabilities(home, await loadSettings(), mcp, []);
		assert.deepEqual(mcp.statuses(), []);
	} finally {
		await mcp.closeAll();
		await fixture.close();
	}
});
