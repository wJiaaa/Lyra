/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 点回复里的按钮替人说话之后，转录有没有回到底部。
 *
 * 同一颗按钮按两次：一次真鼠标（按下会被 `useFollowBottom.hold` 记成锚点），一次脚本 `.click()`
 * （没有 pointerdown，不记锚点）。两次之间只差这一处，量的是发出去之后离底部还有多远。
 *
 * 再点一下历史里的标签页：它让转录变高却不发消息，锚点该照旧把它按在原处——放掉锚点只该发生在
 * 回到底部的时候。
 *
 * 用法：node --experimental-strip-types e2e/send-scroll-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume发送后滚到底测试");
const PORT = 9857;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "send-scroll";

const REPLY = `填一下：

\`\`\`ui
<Card title="报名">
  <Grid cols={2}>
    <Stat label="已报名" value="42"/>
    <Stat label="剩余" value="8"/>
  </Grid>
  <Input name="who" label="姓名" value="小王"/>
  <Choice name="slot" label="场次" options={["上午","下午"]} value="上午"/>
  <Slider name="n" label="人数" min={1} max={10} value={2}/>
  <Toggle name="meal" label="要午餐"/>
  <Button send="提交报名" primary>提交</Button>
</Card>
\`\`\`

填好点「提交」。`;

/** 第二页比第一页高出十几行：切过去转录就长高。 */
const TABS = `两页：

\`\`\`ui
<Tabs>
  <Tab title="短的"><Text>一行。</Text></Tab>
  <Tab title="长的"><Table columns={["序号","内容"]} rows={[${Array.from({ length: 14 }, (_, i) => `[${i + 1},"第 ${i + 1} 行"]`).join(",")}]}/></Tab>
</Tabs>
\`\`\`

完。`;

const LONG = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：收到，正在登记，这一段是为了让回复长到超出一屏。`).join("\n\n");

function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			// 只看最后一句人说的话：请求带着历史，整段里找关键字，回完表单以后每一轮都还是表单。
			const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
			const last = JSON.stringify(parsed.messages.findLast((message) => message.role === "user" && !JSON.stringify(message.content).startsWith('[{"type":"text","text":"<env>'))?.content ?? "");
			void stream(res, last.includes("UI_TABS") ? TABS : last.includes("UI_FORM") ? REPLY : LONG);
		});
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function stream(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	await wait(600);
	for (let at = 0; at < text.length; at += 30) {
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(at, at + 30) } });
		await wait(60);
	}
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "报名", cwd, projectId, projectName: "滚动", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我报个名" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 940, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "滚动", pinned: true, lastOpenedAt: 1 }],
	}));
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
async function say(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);

/** 转录那个滚动区离底部还有多远，和最后一个人的气泡是否在视口里。 */
const GAP = `(() => {
	const block = document.querySelector("main [data-ly-interface]");
	let el = block?.parentElement;
	while (el && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
	if (!el) return null;
	const view = el.getBoundingClientRect();
	const bubble = [...document.querySelectorAll("main .ly-user-bubble")].at(-1)?.getBoundingClientRect();
	return { gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), bubbleInView: Boolean(bubble && bubble.top >= view.top && bubble.bottom <= view.bottom) };
})()`;

/** 发出去以后 3 秒里，每 100ms 量一次。 */
async function after(app: RunningApp, press: () => Promise<void>) {
	const samples: { at: number; gap: number; bubbleInView: boolean }[] = [];
	const start = Date.now();
	await press();
	while (Date.now() - start < 3000) {
		const now = await app.evaluate<{ gap: number; bubbleInView: boolean } | null>(GAP);
		if (now) samples.push({ at: Date.now() - start, ...now });
		await wait(100);
	}
	return samples;
}

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-send-scroll-"));
await seed(home, modelAddress.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);

	console.log("\n一、真鼠标按「提交」");
	await say(app, "UI_FORM 第一张");
	await idle(app);
	await pause(1000);
	const ready = await app.evaluate<{ gap: number } | null>(GAP);
	check("按之前贴着底部", (ready?.gap ?? 99) <= 2, ready);
	await shot(app, "01_按之前");
	const mouse = await after(app, () => click(app!, "main [data-ly-interface] button", "提交"));
	await shot(app, "02_真鼠标按下之后");
	console.log("      采样", JSON.stringify(mouse.map((s) => [s.at, s.gap])));
	// 量的是刚发出去那 0.8 秒：修之前就是这段被按钮的锚点拉回去（离底 113px），之后锚点过期才落到底。
	const early = mouse.filter((s) => s.at <= 800);
	check("真鼠标：发出去的 0.8 秒里一直贴着底部（离底 ≤ 40px）", early.length > 3 && early.every((s) => s.gap <= 40), early.map((s) => s.gap));
	check("真鼠标：这 0.8 秒里自己那条气泡一直在视口里", early.every((s) => s.bubbleInView), early.map((s) => s.bubbleInView));
	await idle(app);
	await pause(800);

	console.log("\n二、脚本 .click()（没有按下，不记锚点）");
	await say(app, "UI_FORM 第二张");
	await idle(app);
	await pause(1000);
	const script = await after(app, async () => {
		await app!.evaluate(`[...document.querySelectorAll("main [data-ly-interface] button")].filter((b) => b.textContent.trim() === "提交").at(-1).click()`);
	});
	await shot(app, "03_脚本点击之后");
	console.log("      采样", JSON.stringify(script.map((s) => [s.at, s.gap])));
	check("脚本点击：发出去以后回到底部（离底 ≤ 40px）", script.at(-1)!.gap <= 40, script.at(-1));
	await idle(app);
	await pause(800);

	console.log("\n三、点开历史里的标签页：按下的那一格不动");
	await say(app, "UI_TABS 再来");
	await idle(app);
	await pause(800);
	// 把标签条挪到视口中间，下面还有东西：切页长高时不被夹在底部。
	await app.evaluate(`document.querySelector('main [data-tab]').closest('[data-ly-interface]').scrollIntoView({ block: "center" })`);
	await pause(600);
	const tabTop = `Math.round([...document.querySelectorAll("main [data-tab]")].find((b) => b.textContent.trim() === "长的").getBoundingClientRect().top)`;
	const top0 = await app.evaluate<number>(tabTop);
	const rows0 = await app.evaluate<number>(`document.querySelectorAll("main [data-ly-interface] tbody tr").length`);
	await click(app, "main [data-tab]", "长的");
	await pause(800);
	const top1 = await app.evaluate<number>(tabTop);
	const rows1 = await app.evaluate<number>(`document.querySelectorAll("main [data-ly-interface] tbody tr").length`);
	await shot(app, "04_切标签页之后");
	check("切到「长的」，表格长出 14 行", rows0 === 0 && rows1 === 14, { rows0, rows1 });
	check("按下的那一格留在原处（漂移 ≤ 1px）", Math.abs(top1 - top0) <= 1, { before: top0, after: top1 });
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_发送后滚到底_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
