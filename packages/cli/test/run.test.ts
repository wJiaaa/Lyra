/**
 * A run against the real runtime: a real `AgentSession`, real tools, the real approval gate — only
 * the model is a script. In a throwaway home so nothing reads or writes `~/.plume`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { bootHostKernel, DEFAULT_SETTINGS, emptyUsage, type AssistantMessage, type HostKernel, type LlmContext, type ModelConfig, type ProviderConfig, type Settings } from "@plume/core";
import { runOnce, SetupError } from "../src/run.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [] };

const says = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({ role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content });

let root = "";
let workspace = "";
let kernel: HostKernel;
const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-cli-"));
	workspace = join(root, "work");
	process.env.PLUME_HOME = join(root, "home", ".plume");
	// Both, because `os.homedir()` reads `USERPROFILE` on Windows.
	process.env.HOME = join(root, "home");
	process.env.USERPROFILE = join(root, "home");
	await mkdir(join(workspace, ".plume", "skills", "demo"), { recursive: true });
	await writeFile(join(workspace, "a.txt"), "hello\n");
	await writeFile(join(workspace, ".plume", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示用的 skill，把事情整理成清单\n---\n\n整理成清单。\n");
	kernel = await bootHostKernel(SETTINGS, () => {});
});

after(async () => {
	await kernel.dispose();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

/** What the model is answering: the newest tool result or human line, past the runtime's `<env>` note. */
function latest(context: LlmContext): string {
	const last = [...context.messages].reverse().find((message) =>
		message.role === "toolResult" || (message.role === "user" && !JSON.stringify(message.content).includes("<env>")));
	return last ? JSON.stringify(last.content) : "";
}

function run(prompt: string, script: (said: string) => AssistantMessage) {
	const lines: string[] = [];
	const seen: string[] = [];
	const result = runOnce({
		prompt, cwd: workspace, settings: SETTINGS, store: kernel.storage, log: (line) => lines.push(line),
		streamFn: async (context) => { const said = latest(context); seen.push(said); return script(said); },
	});
	return { result, lines, seen };
}

test("跑完一个任务：进度只进日志，回答是最后一段不调工具的话", async () => {
	const { result, lines } = run("看看目录", (said) => said.includes("看看目录")
		? says([{ type: "text", text: "先列一下目录。" }, { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } }], "toolUse")
		: says([{ type: "text", text: "目录里有 a.txt。" }]));
	const done = await result;
	assert.equal(done.status, "done");
	assert.equal(done.answer, "目录里有 a.txt。", "调工具前的那句说明不算回答");
	assert.ok(lines.some((line) => line.startsWith("→ ls")), lines.join("\n"));
	assert.ok(done.sessionId);
});

test("需要授权的操作没人能批，当场拒绝而不是等到超时", async () => {
	const started = Date.now();
	const { result, lines } = run("推上去", (said) => said.includes("推上去")
		? says([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "git push --force origin main" } }], "toolUse")
		: says([{ type: "text", text: "推送被拒绝了。" }]));
	const done = await result;
	assert.equal(done.status, "done");
	assert.ok(lines.some((line) => line.startsWith("⚑ 拒绝")), lines.join("\n"));
	assert.ok(Date.now() - started < 10_000, "没有等授权超时");
});

test("/skill 名 参数 按桌面端输入框的方式展开", async () => {
	const { result, seen } = run("/demo 帮我整理", () => says([{ type: "text", text: "整理好了。" }]));
	assert.equal((await result).answer, "整理好了。");
	assert.ok(seen.some((said) => said.includes("Use the `demo` skill") && said.includes("帮我整理")), seen.join("\n"));
});

test("没有默认模型时不开会话，报设置问题", async () => {
	await assert.rejects(
		runOnce({ prompt: "hi", cwd: workspace, settings: { ...SETTINGS, providers: [] }, store: kernel.storage, log: () => {} }),
		SetupError,
	);
});

test("命令行：没给任务或没有模型时退出码是 2，stdout 保持干净", async () => {
	const main = join(import.meta.dirname, "..", "src", "main.ts");
	const env = { ...process.env, PLUME_HOME: join(root, "empty", ".plume"), HOME: join(root, "empty") };
	const call = (args: string[]) => promisify(execFile)(process.execPath, [main, ...args], { env }).then(() => ({ code: 0, stdout: "", stderr: "" }), (error: { code: number; stdout: string; stderr: string }) => error);
	const noModel = await call(["hi"]);
	assert.equal(noModel.code, 2);
	assert.equal(noModel.stdout, "");
	assert.match(noModel.stderr, /没有可用的默认模型/);
	const bad = await call(["--nope"]);
	assert.equal(bad.code, 2);
	assert.match(bad.stderr, /用法/);
});
