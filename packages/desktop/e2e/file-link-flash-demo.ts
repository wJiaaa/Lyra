/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 文件链接「先露出一段字，闪一下才变成卡片」——在真窗口里边验边录。
 *
 * 两条路，每一帧都量（MutationObserver 加 rAF，一帧也漏不掉）：
 *
 * 一、从不在项目里的会话切到项目会话。行内代码里的相对路径 `apps/api/src/http/api-response.ts`
 *    在项目信息读回来之前，不该先画成一整段路径。
 * 二、模型正在写文件链接。`[router.tsx:242](/…/router.tsx)` 地址没写完时不该先露出 label 的字，
 *    `)` 一到再换成卡片。
 *
 * 用法：pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/file-link-flash-demo.ts [输出目录] [标签]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { openSession, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume文件链接闪烁测试");
const LABEL = process.argv[3] ?? "改后";
const PORT = 9861;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const LOOSE = "loose-chat";
const PROJECT_CHAT = "project-chat";
const COMPOSER = 'textarea[aria-label="消息"]';

/** 截图里那条回复的写法：链接 label 是带行号的文件名，地址是绝对路径；行内代码是相对路径。 */
const reply = (project: string) =>
	`1. 详情页由路由 \`/test-cases/$testCaseId\` 承载（[router.tsx:242](${project}/apps/web/src/app/router.tsx)），组件是 [test-cases-page.tsx:173](${project}/apps/web/src/pages/test-cases-page.tsx) 的 \`TestCaseDetailPage\`。\n` +
	`2. 列表接口 [listTestCases](${project}/apps/api/src/services/test-cases/test-case.service.ts)（第 120-171 行）按 \`updatedAt desc, id desc\` 全量返回。\n\n` +
	"工作区里 `apps/api/src/http/api-response.ts`、`apps/web/src/app/providers/task-completion-guard.tsx` 等已有改动是你自己的，我没有碰。";

const FILES = [
	"apps/web/src/app/router.tsx",
	"apps/web/src/pages/test-cases-page.tsx",
	"apps/api/src/services/test-cases/test-case.service.ts",
	"apps/api/src/http/api-response.ts",
	"apps/web/src/app/providers/task-completion-guard.tsx",
];

let streamed = "";
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		req.resume();
		req.on("end", () => void stream(res, streamed));
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 每段 3 个字、隔 45ms：一条链接的地址要写一两秒，够看清它写到一半时是什么样子。 */
async function stream(res: ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	for (let at = 0; at < text.length; at += 3) {
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(at, at + 3) } });
		await wait(45);
	}
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	for (const file of FILES) {
		await mkdir(join(cwd, file, ".."), { recursive: true });
		await writeFile(join(cwd, file), "export {};\n");
	}
	const loose = join(home, "workspaces", "chats", "2026-10-15", "a1b2c3d4");
	await mkdir(loose, { recursive: true });
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = (id: string, title: string, at: string, user: string, answer: string, updatedAt: number) => {
		const meta = { id, title, cwd: at, projectId: id === LOOSE ? "loose" : projectId, projectName: "文件链接", createdAt: 1, updatedAt, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
		return { meta, records: [
			{ type: "meta" as const, meta, seq: 0, ts: 1 },
			{ type: "message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: 1 }, seq: 1, ts: 1 },
			{ type: "message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: answer }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop" as const, timestamp: 2 }, seq: 2, ts: 2 },
			{ type: "meta" as const, meta, seq: 3, ts: 3 },
		] };
	};
	seedSessions(home, [
		session(PROJECT_CHAT, "用例详情页", cwd, "看看这个任务。", reply(cwd), 3),
		session(LOOSE, "随便聊聊", loose, "你好。", "你好。", 2),
	]);
	streamed = reply(cwd);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false, autoSummarizeTitle: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "文件链接", pinned: true, lastOpenedAt: 1 }],
	}));
}

/*
 * 页面里每一次变化、每一帧都看一遍：有没有一段不在文件卡片里、却是那几个文件的字。
 * 卡片里的字是 `[data-ly-file-link]` 的后代；在它外面出现 `api-response.ts` 或 `router.tsx`，就是闪的那一下。
 */
const WATCH = `(() => {
	const names = ["api-response.ts", "task-completion-guard.tsx", "router.tsx", "test-cases-page.tsx", "listTestCases"];
	const seen = window.__flash = { states: 0, frames: 0, samples: [] };
	window.__flashStop = false;
	const loose = () => {
		const found = [];
		for (const prose of document.querySelectorAll("main .prose-dw")) {
			const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
			let text = "";
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!node.parentElement?.closest("[data-ly-file-link]")) text += node.textContent;
			}
			for (const name of names) {
				const at = text.indexOf(name);
				if (at >= 0) found.push(text.slice(Math.max(0, at - 30), at + name.length + 30).replace(/\\s+/g, " "));
			}
		}
		return found;
	};
	new MutationObserver(() => {
		const found = loose();
		if (!found.length) return;
		seen.states++;
		if (seen.samples.length < 6) seen.samples.push(found.join(" | "));
	}).observe(document.body, { subtree: true, childList: true, characterData: true });
	const frame = () => {
		if (loose().length) seen.frames++;
		if (!window.__flashStop) requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
})()`;

const chips = (app: RunningApp) =>
	app.evaluate<string[]>(`[...document.querySelectorAll("main [data-ly-file-link] a")].map((a) => a.textContent.trim())`);

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++;
	else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from(image.data, "base64"));
};
const watch = async (app: RunningApp) => app.evaluate(WATCH);
const result = (app: RunningApp) =>
	app.evaluate<{ states: number; frames: number; samples: string[] }>(`(() => { window.__flashStop = true; const r = window.__flash; return { states: r.states, frames: r.frames, samples: r.samples }; })()`);

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-file-link-flash-"));
await seed(home, address.port);
const renderer = await startDevRenderer();
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home, rendererUrl: renderer.url });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	const expected = ["router.tsx", "test-cases-page.tsx", "listTestCases", "api-response.ts", "task-completion-guard.tsx"];

	console.log("\n一、从不在项目里的会话切过来：行内代码里的路径不先露出来");
	await openSession(app, LOOSE);
	await until(app, `document.querySelector("main .prose-dw")`, 900);
	await pause(1000);
	await watch(app);
	await openSession(app, PROJECT_CHAT);
	await until(app, `document.querySelectorAll("main [data-ly-file-link]").length >= 5`, 900);
	await pause(1200);
	const opened = await result(app);
	check("切过来的每一帧里，文件名都只在卡片里出现", opened.states === 0 && opened.frames === 0, opened);
	check("五个文件都画成了卡片，只显示文件名", JSON.stringify(await chips(app)) === JSON.stringify(expected), await chips(app));
	await shot(app, "01_切到项目会话后");

	console.log("\n二、模型正在写文件链接：地址没写完时不先露出字");
	await watch(app);
	await type(app, COMPOSER, "再说一遍。");
	await pause(500);
	await press(app, "Enter", 13);
	// 第一条链接的地址正写到一半：新回复里已经有了「承载（」，卡片还没出来。
	await until(app, `document.querySelectorAll("main [data-ly-file-link]").length === 5 && document.querySelector("main").textContent.split("承载（").length > 2`, 1200);
	// 地址整段要写一秒七上下；等 0.9 秒，label 早该写完、`)` 还没到。
	await pause(900);
	await shot(app, "02_链接地址写到一半");
	await until(app, `!document.querySelector('button[aria-label="停止"]') && document.querySelectorAll("main [data-ly-file-link]").length >= 10`, 2400);
	await pause(1500);
	const written = await result(app);
	check("写的每一帧里，文件名都只在卡片里出现", written.states === 0 && written.frames === 0, written);
	const all = await chips(app);
	check("写完后两条回复都是同样五张卡片", JSON.stringify(all) === JSON.stringify([...expected, ...expected]), all);
	await shot(app, "03_写完");
} finally {
	await stopRecording?.();
	await app?.stop();
	await renderer.close();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const video = join(OUT_DIR, `${STAMP}_${LABEL}_文件链接闪烁_${passes}of${passes + failures}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${passes + failures} 通过\n视频：${video}`);
process.exit(failures ? 1 : 0);
