/* oxlint-disable no-console -- this probe reports measured window and request assertions */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, projectIdFor } from "../../core/src/session/store.ts";
import { emptyUsage } from "../../core/src/types.ts";
import type { ContextBreakdown } from "../../core/src/runtime/context.ts";
import { closeListeningServer, startApp } from "./app.ts";
import { driver, encode, frameGrabber, pause, startRecording, type Frame } from "./record.ts";

const evidence = join(homedir(), "Desktop", "Plume上下文组装测试");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const profile = await mkdtemp(join(tmpdir(), "plume-context-window-"));
const cwd = join(profile, "project");
const projectId = projectIdFor(cwd);
const requests: { system: { text: string }[]; tools?: { name: string }[] }[] = [];
const frames: Frame[] = [];
const measurements: { label: string; actual: unknown }[] = [];
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

const server = createServer((req, res) => {
	let raw = "";
	// HTTP chunks can split a multibyte character; keep the decoder state across chunks.
	req.setEncoding("utf8");
	req.on("data", chunk => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw) as typeof requests[number];
		const normal = JSON.stringify(body.system).includes("CONTEXT_FIXTURE_IDENTITY");
		if (normal) requests.push(body);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		emit("message_start", { message: { id: "context-fixture", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
		emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: normal ? `第 ${requests.length} 轮上下文验收完成。` : "上下文验收" } });
		emit("content_block_stop", { index: 0 });
		emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } });
		emit("message_stop", {});
		res.end();
	});
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const modelPort = (server.address() as { port: number }).port;
await mkdir(evidence, { recursive: true });
await mkdir(join(cwd, ".plume", "prompts"), { recursive: true });
await writeFile(join(cwd, "AGENTS.md"), `RULE_ORIGINAL\n${"项目规则。".repeat(10_000)}`);
await writeFile(join(cwd, ".plume", "prompts", "identity.md"), "CONTEXT_FIXTURE_IDENTITY：按用户要求完成隔离上下文验收。");
for (let index = 0; index < 130; index++) {
	const dir = join(cwd, ".plume", "skills", `fixture-${index}`);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: fixture-${index}\ndescription: ${"这是隔离测试用的技能目录描述。".repeat(30)}\n---\n正文按需加载。\n`);
}
const model = { id: "fixture/context", providerId: "fixture", modelId: "context", name: "上下文验收模型", contextWindow: 1_000_000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false };
await writeFile(join(profile, "settings.json"), JSON.stringify({
	providers: [{ id: "fixture", name: "隔离测试", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "fixture", enabled: true, models: [model] }],
	defaultModelId: model.id, permissionMode: "full", thinking: "off", personalization: { enableMemory: false }, mcpServers: [], hooks: [],
	projects: [{ id: projectId, path: cwd, name: "上下文组装验收", pinned: true, lastOpenedAt: Date.now() }], appearance: { theme: "light" }, uiLocale: "zh-CN",
}));
await writeFile(join(profile, "window.json"), JSON.stringify({ width: 1400, height: 960 }));
const store = new SessionStore(join(profile, "sessions"));
let meta = await store.create(cwd, model.id, "上下文来源与预算验收");
meta = await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "准备验证上下文来源、预算和统计。" }], timestamp: 1 } });
await store.append(meta, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "隔离测试已准备好。" }], provider: "fixture", model: "context", api: "anthropic-messages", usage: emptyUsage(), stopReason: "stop", timestamp: 2 } });
Object.assign(process.env, { HOME: profile, USERPROFILE: profile });
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let grab: Awaited<ReturnType<typeof frameGrabber>> | undefined;
let stopRecording: (() => Promise<void>) | undefined;
try {
	app = await startApp({ port: 9583, reuseHome: profile });
	const d = driver(app);
	grab = await frameGrabber(9583);
	stopRecording = await startRecording(9583, frames);
	const check = (label: string, condition: boolean, actual: unknown) => {
		assert.ok(condition, `${label}: ${JSON.stringify(actual)}`);
		measurements.push({ label, actual });
		console.log(`PASS ${label}: ${JSON.stringify(actual)}`);
	};
	const shot = async (label: string) => {
		await pause(1100);
		frames.push({ at: Date.now(), data: await grab!.shot() });
		const captured = await grab!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(evidence, `${stamp}_${label}.png`), Buffer.from(captured.data, "base64"));
	};
	const detail = () => app!.evaluate<ContextBreakdown>(`window.plume.sessions.contextBreakdown(${JSON.stringify(meta.id)})`);
	const panel = async (open: boolean) => {
		const expanded = await app!.evaluate<string>('document.querySelector(".ly-ring-button").getAttribute("aria-expanded")');
		if (expanded !== String(open)) await d.click(".ly-ring-button");
		await d.until(`document.querySelector(".ly-ring-button").getAttribute("aria-expanded") === ${JSON.stringify(String(open))}`, 5000);
	};
	await d.click(`[data-ly-row="${meta.id}"]`);
	await d.until('document.body.innerText.includes("隔离测试已准备好")', 15000);
	await panel(true);
	await shot("01_发送前预算预览");
	await panel(false);
	await d.click("main textarea");
	await d.type("请验收第一轮上下文。");
	await d.submit();
	await d.until('document.body.innerText.includes("第 1 轮上下文验收完成")', 20000);
	const first = await detail();
	const sent = requests[0].system.map(block => block.text).join("");
	check("实际请求包含项目规则截断提示", sent.includes("Instructions truncated at 100 KiB"), Buffer.byteLength(sent));
	const skills = sent.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? "";
	check("技能软预算保留130个名称并移除描述", (skills.match(/<name>fixture-/g) ?? []).length === 130 && !skills.includes("<description>"), skills.length);
	check("工具过滤与实际请求一致", !requests[0].tools?.some(tool => tool.name === "task" || tool.name === "learn"), requests[0].tools?.length);
	check("段落统计等于实际system字符串估算", first.sources!.reduce((sum, source) => sum + source.tokens, 0) === Math.ceil(sent.length / 3.5), { tokens: first.sources!.reduce((sum, source) => sum + source.tokens, 0), expected: Math.ceil(sent.length / 3.5), characters: sent.length, end: first.sources!.at(-1)?.end });
	check("分项统计之和等于总量", first.segments.reduce((sum, segment) => sum + segment.tokens, 0) === first.used, first.used);
	await panel(true);
	await d.until('document.querySelector(\'[role="group"][aria-label="上下文窗口用量"]\')?.checkVisibility()', 5000);
	await d.markByText('/^记忆文件/', 'data-context-files');
	await d.click('[data-context-files]');
	const box = await app.evaluate<{ width: number; height: number }>('(()=>{const r=document.querySelector(".ly-ring-button").getBoundingClientRect();return {width:r.width,height:r.height};})()');
	check("上下文入口在真实窗口可见", box.width > 0 && box.height > 0, box);
	await shot("02_实际请求的上下文统计");
	await writeFile(join(cwd, "AGENTS.md"), "RULE_UPDATED：这是第二轮的新规则。");
	const unchanged = await detail();
	check("文件变化不改写已发送请求的来源统计", JSON.stringify(unchanged.sources) === JSON.stringify(first.sources), unchanged.memoryFiles);
	await shot("03_文件变化后保留请求快照");
	await panel(false);
	await d.click("main textarea");
	await d.type("请验收第二轮上下文。");
	await d.submit();
	await d.until('document.body.innerText.includes("第 2 轮上下文验收完成")', 20000);
	const second = await detail();
	check("下一轮读取新规则并更新统计", requests[1].system.some(block => block.text.includes("RULE_UPDATED")) && second.memoryFiles![0].tokens < first.memoryFiles![0].tokens, { before: first.memoryFiles, after: second.memoryFiles });
	await panel(true);
	await shot("04_下一轮的新规则与统计");
	await stopRecording(); stopRecording = undefined;
	await encode(frames, join(evidence, `${stamp}_上下文组装_${measurements.length}of${measurements.length}.mp4`), 12);
	await writeFile(join(evidence, `${stamp}_断言_${measurements.length}of${measurements.length}.json`), JSON.stringify(measurements, null, 2));
	console.log(`证据：${evidence}`);
} finally {
	await stopRecording?.().catch(() => {});
	grab?.close();
	await app?.stop();
	await closeListeningServer(server);
	for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await rm(profile, { recursive: true, force: true });
}
