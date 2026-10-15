/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 计划面板在真窗口里走一遍：计划交上来时右栏自己打开「计划」标签，面板里划一段字留评论，
 * 选「要改」时评论跟着打回理由一起到了模型那里，之后面板只读。
 *
 * 模型是本地起的假服务（照 `plan-mode-demo.ts`）：收到 `PLAN_ME` 就交一份五步计划，收到打回就说一句话收尾，
 * 并记下每次请求的最后两条消息——评论真的到了 core、进了发给模型的那条工具结果，就是在这里量出来的。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/plan-panel-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeTab, frames as settle, openSession, press, selectText, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume计划面板测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9872;
const SESSION = "plan-panel";
const FIELD = "main textarea";
const PANE = '[data-dock-content="plan"]';
const BODY = `${PANE} [data-plan-body]`;
const INPUT = "[data-plan-comment-input]";

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const PLAN = {
	title: "登录改成 OAuth",
	steps: [
		{ what: "读现有的账号密码登录流程，列出调用点", files: ["src/auth/login.ts"] },
		{ what: "加 OAuth 回调路由，换取 token 后写会话", files: ["src/auth/oauth.ts", "src/routes.ts"] },
		{ what: "登录页把表单换成「用 GitHub 登录」按钮", files: ["src/pages/Login.tsx"] },
		{ what: "旧的密码登录保留一个版本，打开开关才走", files: ["src/config.ts"] },
		{ what: "补回调和会话写入的测试", files: ["test/oauth.test.ts"] },
	],
	risks: ["回调地址在本地和线上不同，配错了登录直接失败"],
	unknowns: ["线上用的是哪个 OAuth 应用"],
};

const requests: { tail: string }[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: unknown[] };
			const tail = JSON.stringify(body.messages.slice(-2));
			requests.push({ tail });
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes('"tool_result"')) reply(res, "好，我按评论改一版。");
			else if (tail.includes("PLAN_ME")) reply(res, "", PLAN);
			else reply(res, "好的。");
		});
	});
}

function reply(res: ServerResponse, text: string, plan?: typeof PLAN) {
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: "plan", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: plan ? { type: "tool_use", id: "plan-1", name: "submit_plan", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: plan ? { type: "input_json_delta", partial_json: JSON.stringify(plan) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: plan ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# plan panel\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "计划面板", cwd, projectId, projectName: "计划面板", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "登录这块想换掉。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "可以，先说说想换成什么。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		// 逐项询问档：卡片上才有「接受并开启自动模式」。
		permissionMode: "ask",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "计划面板", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

async function photo(name: string) {
	await mkdir(out, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 面板与卡片此刻的样子，全从看得见的 DOM 和登记的高亮量。 */
async function state() {
	return app!.evaluate<{ pane: boolean; tabActive: boolean; h1: string; steps: number; hint: boolean; comments: string[]; marked: number; draft: number; title: string; count: string; cardH2: number; options: number; actions: string[]; button: boolean; cardHeight: number }>(`(()=>{
		const pane=document.querySelector(${JSON.stringify(PANE)});
		const visible=pane&&pane.checkVisibility({visibilityProperty:true});
		const card=document.querySelector('[data-approval-card]');
		return {
			pane:Boolean(visible),
			tabActive:Boolean(document.querySelector('[data-dock-pane]:not([inert]) [data-panel-tab="plan"] [aria-selected="true"]')),
			h1:pane?.querySelector('[data-plan-body] h1')?.textContent??"",
			steps:pane?.querySelectorAll('[data-plan-body] ol > li').length??0,
			hint:Boolean(pane?.querySelector('[data-plan-hint]')),
			comments:[...(pane?.querySelectorAll('[data-plan-comment]')??[])].map(e=>e.textContent),
			marked:CSS.highlights.get('ly-plan-comment')?.size??0,
			draft:CSS.highlights.get('ly-plan-draft')?.size??0,
			title:card?.querySelector('[data-approval-title]')?.textContent??"",
			count:card?.querySelector('[data-approval-plan-comments]')?.textContent??"",
			cardH2:card?.querySelectorAll('h2').length??0,
			options:card?.querySelectorAll('[data-ly-question-option]').length??0,
			actions:[...(card?.querySelectorAll('[data-plan-action]')??[])].map(e=>e.textContent),
			button:Boolean(card?.querySelector('[data-approval-open-plan]')),
			cardHeight:Math.round(card?.getBoundingClientRect().height??0),
		};
	})()`);
}

async function comment(quote: string, text: string, photoName?: string) {
	await selectText(app!, BODY, quote);
	await until(app!, `document.activeElement?.matches(${JSON.stringify(INPUT)})`, 300);
	await pause(500);
	await app!.send("Input.insertText", { text });
	await pause(600);
	if (photoName) await photo(photoName);
	await press(app!, "Enter", 13);
	await settle(app!, 10);
	await pause(800);
}

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(900);

	await type(app, FIELD, "/plan PLAN_ME 把登录改成 OAuth");
	await pause(400);
	await press(app, "Enter", 13);
	await until(app, "document.querySelector('[data-approval-card]')", 1200);
	await until(app, `document.querySelector(${JSON.stringify(BODY)})`, 600);
	await pause(1200);

	const opened = await state();
	check("计划交上来，右栏自己打开「计划」标签并摆在前台", opened.pane && opened.tabActive, opened);
	check("面板按 Markdown 摊开整份计划：标题和五步", opened.h1 === PLAN.title && opened.steps === 5, { h1: opened.h1, steps: opened.steps });
	check("面板顶上提示可以划线评论", opened.hint, opened.hint);
	const waitingLine = await app.evaluate<string>(`document.querySelector('[data-ly-waiting]')?.textContent??""`);
	check("对话底部那一行说的是「等你审批计划」", waitingLine === "等你审批计划", waitingLine);
	check("审批卡是一行标题加「打开计划」，不再重画正文", opened.title === "Plume 提出了一个计划" && opened.button && opened.cardH2 === 0 && opened.options === 0, { title: opened.title, cardH2: opened.cardH2, options: opened.options });
	check("一排动作：拒绝、修改…、接受、接受并开启自动模式", opened.actions.length === 4 && opened.actions[0] === "拒绝" && opened.actions[1]!.startsWith("修改…") && opened.actions[2]!.startsWith("接受") && opened.actions[3]!.startsWith("接受并开启自动模式"), opened.actions);
	check("「打开计划」是强调色的链接", await app.evaluate<string>(`getComputedStyle(document.querySelector('[data-approval-open-plan]')).color`) === await app.evaluate<string>(`(()=>{const e=document.createElement('span');e.className='text-accent';document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c;})()`), null);
	check("卡片矮到两行：不超过 110px", opened.cardHeight > 0 && opened.cardHeight <= 110, opened.cardHeight);
	await photo("01_计划交上来右栏自动打开");

	await selectText(app, BODY, "加 OAuth 回调路由");
	await until(app, `document.activeElement?.matches(${JSON.stringify(INPUT)})`, 300);
	await pause(500);
	const drafting = await state();
	check("划一段字，评论框弹出并拿到焦点；那段字仍然标着", drafting.draft === 1, { draft: drafting.draft });
	await app.send("Input.insertText", { text: "回调里先校验 state，防 CSRF" });
	await pause(700);
	await photo("02_划线写评论");
	await press(app, "Enter", 13);
	await settle(app, 10);
	await pause(900);

	const one = await state();
	check("回车留下评论：列在正文下方，那段字换成评论的标记", one.comments.length === 1 && one.comments[0]!.includes("回调里先校验 state") && one.marked === 1 && one.draft === 0, { comments: one.comments, marked: one.marked, draft: one.draft });
	check("审批卡上显示「1 条评论」", one.count === "1 条评论", one.count);

	await comment("旧的密码登录保留一个版本", "不用保留，直接删掉");
	const two = await state();
	check("第二条评论，按正文里的先后排", two.comments.length === 2 && two.comments[1]!.includes("直接删掉") && two.marked === 2 && two.count === "2 条评论", { comments: two.comments, marked: two.marked });
	await photo("03_两条评论");

	await closeTab(app, "plan");
	await pause(600);
	check("关掉计划标签", !(await state()).pane, null);
	await click(app, "[data-approval-open-plan]");
	await until(app, `document.querySelector(${JSON.stringify(BODY)})`, 300);
	await pause(800);
	const back = await state();
	check("点卡片上的「打开计划」叫回来，评论还在", back.pane && back.comments.length === 2 && back.marked === 2, { pane: back.pane, comments: back.comments.length, marked: back.marked });
	await photo("04_打开计划叫回面板");

	await click(app, '[data-plan-action="revise"]');
	await until(app, "document.activeElement?.matches('[data-plan-revise-input]')", 300);
	await pause(400);
	await app.send("Input.insertText", { text: "另外拆成两次提交" });
	await pause(700);
	await photo("05_修改意见");
	await click(app, "[data-plan-send-revision]");
	await until(app, "!document.querySelector('[data-approval-card]')", 1200);
	await pause(1500);
	const feedback = requests.find((request) => request.tail.includes('"tool_result"'))?.tail ?? "";
	check("点「修改…」写一句发出，那句话和两条评论连着引文进了发给模型的工具结果", feedback.includes("另外拆成两次提交") && feedback.includes("加 OAuth 回调路由") && feedback.includes("回调里先校验 state") && feedback.includes("旧的密码登录保留一个版本") && feedback.includes("直接删掉"), feedback.slice(0, 400));

	const after = await state();
	check("审批结束后面板留着那份计划，只读：提示、评论、标记都撤了", after.pane && after.steps === 5 && !after.hint && after.comments.length === 0 && after.marked === 0, after);
	await photo("06_打回后面板只读");
	await pause(800);
} catch (error) {
	check("验证脚本跑完", false, String(error));
	await photo("失败现场").catch(() => {});
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	await mkdir(out, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_计划面板划线评论_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
