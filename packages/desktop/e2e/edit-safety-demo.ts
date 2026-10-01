/* oxlint-disable no-console -- replayable probe reports measured app behavior */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, frameGrabber, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume编辑工具测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-");
const port = 9657, session = "edit-safety";
const original = "alpha\r\nbeta\r\ngamma\r\ndelta";
const literal = "$& $$ $` $'";
const expected = `${literal}\r\ninserted\r\nbeta\r\ngamma\r\nend-delta`;
const results: { tool_use_id: string; is_error?: boolean; content: unknown }[] = [];
const checks: { what: string; ok: boolean; saw: unknown }[] = [];
let step = 0, tag = "", project = "";
let app: RunningApp | undefined;

function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ what, ok, saw }); console.log(`${ok ? "✅" : "❌"} ${what}: ${JSON.stringify(saw)}`);
}

function answer(res: ServerResponse, index: number, tool?: { name: string; input: object }) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `edit-${index}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${index}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "编辑验证完成。重叠操作和未读行修改已拒绝，重读后的编辑已保存，可以审阅和撤销。" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 30 } });
	emit("message_stop", {}); res.end();
}

// Only the provider is scripted: tools, snapshots, rendering and undo all run in the real app.
const server = createServer((req, res) => {
	let raw = ""; req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		const body = JSON.parse(raw);
		if (!body.tools?.length) { answer(res, -1); return; }
		const last = body.messages?.at(-1)?.content;
		if (Array.isArray(last)) for (const result of last.filter((part: { type: string }) => part.type === "tool_result")) {
			results.push(result);
			const match = /(?:#|New tag: )([0-9A-F]{4})/.exec(JSON.stringify(result.content));
			if (match) tag = match[1];
		}
		const script = [
			{ name: "read", input: { path: "sample.txt", offset: 1, limit: 2 } },
			{ name: "edit", input: { path: "sample.txt", tag, patch: "REPLACE 1-2\n+bad\nINSERT AFTER 1\n+lost" } },
			{ name: "edit", input: { path: "sample.txt", tag, patch: "INSERT AFTER 1\n+inserted" } },
			{ name: "edit", input: { path: "sample.txt", tag, patch: "REPLACE 4-4\n+unseen" } },
			{ name: "read", input: { path: "sample.txt" } },
			{ name: "edit", input: { path: "sample.txt", old_string: "alpha", new_string: literal } },
			{ name: "edit", input: { path: "sample.txt", tag, patch: "REPLACE 5-5\n+end-delta" } },
		];
		const index = step++;
		setTimeout(() => answer(res, index, script[index]), 1100);
	});
});

const frames: Frame[] = [];
let stopRecording: (() => Promise<void>) | undefined;
let grab: Awaited<ReturnType<typeof frameGrabber>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let sampling: Promise<void> | undefined;
await mkdir(out, { recursive: true });
try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	app = await startApp({ port, seed: async (home) => {
		project = join(home, "project"); await mkdir(project);
		await writeFile(join(project, "sample.txt"), original);
		const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const meta = { id: session, title: "编辑保护与撤销", cwd: project, projectId, projectName: "编辑验证", createdAt: 1, updatedAt: 3, modelId: "qa/model", messageCount: 2, seq: 3, usage };
		seedSessions(home, [{ meta, records: [
			{ type: "meta", meta, seq: 1, ts: 1 },
			{ type: "message", seq: 2, ts: 2, message: { role: "user", content: [{ type: "text", text: "准备验证文件编辑。" }], timestamp: 2 } },
			{ type: "message", seq: 3, ts: 3, message: { role: "assistant", content: [{ type: "text", text: "可以开始。" }], timestamp: 3, usage, api: "anthropic-messages", provider: "qa", model: "model", stopReason: "stop" } },
		] }]);
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 850 }));
		await writeFile(join(home, "settings.json"), JSON.stringify({
			providers: [{ id: "qa", name: "本地验证模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", enabled: true,
				models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsImages: false, supportsThinking: false }] }],
			defaultModelId: "qa/model", permissionMode: "full", thinking: "off", projectMemory: false,
			mcpServers: [], hooks: [], sync: { enabled: false }, screenshot: { enabled: false, shortcut: "" },
			projects: [{ id: projectId, path: project, name: "编辑验证", pinned: true, lastOpenedAt: 1 }],
		}));
	} });
	stopRecording = await startRecording(port, frames);
	grab = await frameGrabber(port);
	// Force app-only frames when the test window is occluded; never capture the desktop.
	timer = setInterval(() => {
		if (sampling) return;
		sampling = grab!.shot().then((data) => { frames.push({ at: Date.now(), data }); }).finally(() => { sampling = undefined; });
	}, 500);
	const d = driver(app);
	await d.click(`[data-ly-row="${session}"]`); await pause(1000);
	await d.click('[data-dock-pane="conversation"] textarea');
	await app.send("Input.insertText", { text: "验证编辑保护：先读取局部，尝试重叠和未读行修改，再重读并正确编辑，最后审阅与撤销。" });
	await pause(1000); await d.key("Enter", 13);
	await d.until("document.querySelector('[data-turn-delivery]') && document.body.innerText.includes('编辑验证完成')", 60000);
	await pause(1200);
	check("工具调用真实完成", results.length === 7, results.length);
	check("重叠操作被拒绝", results[1]?.is_error === true && /overlap|inside/i.test(JSON.stringify(results[1].content)), results[1]);
	check("编辑后仍拒绝未读行", results[3]?.is_error === true && /not in what you read/.test(JSON.stringify(results[3].content)), results[3]);
	check("合法编辑和重读成功", [0, 2, 4, 5, 6].every((i) => results[i] && !results[i].is_error), results.map((r) => !!r.is_error));
	const actual = await readFile(join(project, "sample.txt"), "utf8");
	check("美元字符、CRLF 和无末尾换行保持准确", actual === expected, { actual, bytes: Buffer.byteLength(actual) });
	await d.click('[data-turn-delivery] button[data-ly-tip="审核全部文件改动"]');
	await d.until("document.querySelector('[data-dock-pane=\"delivery\"] .ly-diff-scroll')", 20000);
	await pause(1800);
	const visible = await app.evaluate<{ adds: string[]; removes: string[]; width: number }>(`(()=>{const diff=document.querySelector('[data-dock-pane="delivery"] .ly-diff-scroll');return {adds:[...diff.querySelectorAll('.ly-diff-add')].map(e=>e.innerText),removes:[...diff.querySelectorAll('.ly-diff-remove')].map(e=>e.innerText),width:diff.getBoundingClientRect().width}})()`);
	check("审阅面板显示三行新增、两行删除", visible.adds.length === 3 && visible.removes.length === 2 && visible.width >= 250 && visible.adds.some((s) => s.includes("end-delta")), visible);
	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_差异审阅.png`), Buffer.from(shot.data, "base64"));
	await d.key("Escape", 27); await pause(1000);
	await d.click('[data-turn-delivery] button[data-ly-tip="撤销这次文件改动"]');
	await d.until("document.querySelector('[role=\"dialog\"]')", 20000); await pause(1200);
	await app.evaluate(`(()=>{const button=[...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent.includes('撤销改动'));if(!button)throw Error('Missing confirm');button.click()})()`);
	await d.until("!document.querySelector('[data-turn-delivery] button[data-ly-tip=\"撤销这次文件改动\"]')", 20000);
	await pause(1500);
	const restored = await readFile(join(project, "sample.txt"));
	check("撤销后原文件逐字节恢复", restored.equals(Buffer.from(original)), { bytes: restored.length, sha256: createHash("sha256").update(restored).digest("hex") });
	check("撤销后的可见按钮状态正确", await app.evaluate("!document.querySelector('[data-turn-delivery] button[data-ly-tip=\"撤销这次文件改动\"]')"), "撤销按钮已移除");
	const afterShot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_撤销完成.png`), Buffer.from(afterShot.data, "base64"));
} catch (error) {
	check("真实应用流程完成", false, String(error));
	if (app) await writeFile(join(out, `${stamp}_失败界面.txt`), await app.evaluate<string>("document.body.innerText"));
} finally {
	if (timer) clearInterval(timer);
	await sampling;
	await stopRecording?.(); grab?.close();
	const passed = checks.filter((c) => c.ok).length;
	await writeFile(join(out, `${stamp}_断言.json`), JSON.stringify(checks, null, 2));
	try {
		if (frames.length) {
			frames.sort((a, b) => a.at - b.at);
			const video = join(out, `${stamp}_编辑保护与撤销_${passed}of${checks.length}.mp4`);
			await encode(frames, video, 24); console.log(video);
		}
	} finally {
		await app?.stop(); await closeListeningServer(server);
		if (app) await rm(app.home, { recursive: true, force: true });
	}
	if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
