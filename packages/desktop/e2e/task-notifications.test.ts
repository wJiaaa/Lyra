import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { frames, shot } from "./drive.ts";

let app: RunningApp;
let server: Server;
let held: ServerResponse | undefined;
let requestArrived: (() => void) | undefined;
let holdNext = false;
let requests = 0;
function reply(res: ServerResponse, text: string, tool?: { name: string; input: Record<string, unknown> }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `notice-${requests}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `tool-${requests}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {}); res.end();
}
before(async () => {
	server = createServer((req, res) => {
		req.resume(); req.on("end", () => {
			requests++;
			res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
			if (holdNext) { held = res; holdNext = false; requestArrived?.(); }
			else reply(res, "审批流程已结束。");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	app = await startApp({ port: 9613, seed: async (home) => {
		// Only provider responses and disk fixtures are synthetic; the renderer and IPC stay real.
		await seedInteractions(home, address.port);
		const file = join(home, "settings.json"); const settings = JSON.parse(await readFile(file, "utf8"));
		settings.permissionMode = "ask"; settings.projectMemory = false;
		await writeFile(file, JSON.stringify(settings));
	} });
});
afterEach(async (t) => {
	if (!t.passed) {
		await shot(app, "notifications-failure");
		t.diagnostic(await app.evaluate<string>(`document.body.innerText.slice(-3000)`));
	}
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });
async function until<T = unknown>(expression: string, matches: (value: T) => boolean = Boolean) {
	const deadline = Date.now() + 10000;
	while (!matches(await app.evaluate<T>(expression))) {
		if (Date.now() >= deadline) throw new Error(`Notification condition timed out: ${expression}`);
		await delay(20);
	}
}
const targets = {
	showSidebar: `document.querySelector('button[aria-label^="显示侧边栏"]')`,
	hideSidebar: `document.querySelector('button[aria-label^="隐藏侧边栏"]')`,
	short: `document.querySelector('[data-ly-row="qa-short"] > button')`,
	long: `document.querySelector('[data-ly-row="qa-long"] > button')`,
	composer: `document.querySelector('main textarea')`,
	send: `document.querySelector('button[aria-label="发送"]')`,
	jump: `document.querySelector('[role="status"] button[aria-label="跳转到该会话"]')`,
	cancel: `document.querySelector('[data-qa-cancel]')`,
};
async function click(target: keyof typeof targets) {
	const query = targets[target];
	await until(`${query}?.checkVisibility()`);
	await app.evaluate(`${query}.scrollIntoView({block:'nearest',behavior:'instant'})`); await frames(app, 3);
	await until(`(()=>{const e=${query},r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
	const at = await app.evaluate<{ x: number; y: number }>(`(()=>{const r=${query}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await app.send("Input.dispatchMouseEvent", { type, ...at, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
	await frames(app, 3);
}
async function chooseSession(id: "qa-short" | "qa-long") {
	if (await app.evaluate<boolean>(`!!document.querySelector('button[aria-label^="显示侧边栏"]')`)) await click("showSidebar");
	await click(id === "qa-short" ? "short" : "long");
	await until<string>(`document.querySelector('.ly-transcript')?.textContent ?? ''`, (text) => text.includes(id));
}
async function collapseSidebar() {
	if (await app.evaluate<boolean>(`!!document.querySelector('button[aria-label^="隐藏侧边栏"]')`)) await click("hideSidebar");
}
async function begin(prompt: string) {
	await chooseSession("qa-short");
	held = undefined; holdNext = true;
	const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
	await click("composer"); await app.send("Input.insertText", { text: prompt });
	await click("send");
	await arrived;
	await chooseSession("qa-long"); await collapseSidebar();
}
async function appearance(theme: "light" | "dark", width: number) {
	await app.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
	await app.evaluate(`(async()=>{const s=await window.plume.settings.get();await window.plume.settings.save({...s,appearance:{...s.appearance,theme:${theme === "light" ? '"light"' : '"dark"'}}});})()`);
	await until(`document.documentElement.classList.contains(${theme === "light" ? '"light"' : '"dark"'})`); await frames(app, 20);
}

test("background completion stays compact in both themes and narrow windows, then opens its own conversation", async (t) => {
	const surfaces = new Map<string, string>();
	for (const theme of ["light", "dark"] as const) for (const width of [1200, 375]) {
		await appearance(theme, width);
		const result = `完成通知回归 ${theme} ${width}`;
		await begin(`触发后台完成 ${theme} ${width}`); assert.ok(held); reply(held, result);
		await until(`Boolean(document.querySelector('[role="status"] button[aria-label="跳转到该会话"]'))`); await frames(app, 20);
		const metrics = await app.evaluate<{ cards: number; text: string; x: number; right: number; height: number; scroll: number; client: number; buttons: string[]; background: string; color: string; badge: { width: number; height: number; animation: string; color: string } }>(`(()=>{const action=document.querySelector('[role="status"] button[aria-label="跳转到该会话"]'),card=action.closest('[role="status"]'),r=card.getBoundingClientRect(),s=getComputedStyle(card),badge=document.querySelector('button[aria-label*="有任务已完成"] span.bg-ok'),b=badge.getBoundingClientRect();return {cards:document.querySelectorAll('[role="status"] button[aria-label="跳转到该会话"]').length,text:card.innerText,x:r.x,right:r.right,height:r.height,scroll:card.scrollWidth,client:card.clientWidth,buttons:[...card.querySelectorAll('button')].map(e=>e.getAttribute('aria-label')),background:s.backgroundColor,color:s.color,badge:{width:b.width,height:b.height,animation:getComputedStyle(badge).animationName,color:getComputedStyle(badge).backgroundColor}};})()`);
		assert.equal(metrics.cards, 1); assert.deepEqual(metrics.buttons, ["跳转到该会话", "关闭"]);
		assert.ok(metrics.x >= 0 && metrics.right <= width && metrics.height <= 56, JSON.stringify(metrics));
		assert.ok(metrics.scroll <= metrics.client, "the toast has no horizontal overflow");
		assert.deepEqual({ ...metrics.badge, color: "" }, { width: 6, height: 6, animation: "none", color: "" });
		assert.ok(metrics.text.length < 40); surfaces.set(theme, metrics.background);
		t.diagnostic(JSON.stringify({ theme, width, ...metrics })); await shot(app, `completion-${theme}-${width}`);
		await click("jump");
		await until<string>(`document.querySelector('.ly-transcript')?.textContent ?? ''`, (text) => text.includes(result));
		await until(`!document.querySelector('[role="status"] button[aria-label="跳转到该会话"]')`);
		const painted = await app.evaluate<string[]>(`(async()=>{const out=[];for(let n=0;n<20;n++){await new Promise(requestAnimationFrame);out.push(document.querySelector('.ly-transcript')?.textContent ?? '');}return out;})()`);
		assert.ok(painted.every((text) => text.includes(result)), "the source result remains visible throughout navigation settling");
		assert.equal(await app.evaluate(`!!document.querySelector('button[aria-label*="有任务已完成"]')`), false);
	}
	assert.notEqual(surfaces.get("light"), surfaces.get("dark"), "the toast surface uses the active theme");
});

test("ordinary approvals and interactive questions expose one waiting badge and their own decision UI", async (t) => {
	const cases = [
		{ theme: "dark", width: 1200, name: "bash", input: { command: "rm -rf ./notification-e2e-unused", description: "通知验证：清理隔离测试目录" }, expected: "rm -rf ./notification-e2e-unused", cancelQuery: `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith("拒绝"))` },
		{ theme: "light", width: 375, name: "ask_user", input: { question: "请选择通知验证方案", options: ["保留方案 A", "保留方案 B"], allowCustomInput: true }, expected: "请选择通知验证方案", cancelQuery: `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith("取消"))` },
	] as const;
	for (const scenario of cases) {
		await appearance(scenario.theme, scenario.width); await begin(`审批通知回归 ${scenario.name}`);
		assert.ok(held); reply(held, "", { name: scenario.name, input: scenario.input });
		await until(`Boolean(document.querySelector('button[aria-label*="有任务等待处理"]'))`);
		const badge = await app.evaluate<{ animation: string; color: string }>(`(()=>{const b=document.querySelector('button[aria-label*="有任务等待处理"] span.bg-accent');return {animation:getComputedStyle(b).animationName,color:getComputedStyle(b).backgroundColor};})()`);
		assert.equal(badge.animation, "none");
		await chooseSession("qa-short"); await collapseSidebar();
		await until<string>(`document.querySelector('main')?.textContent ?? ''`, (text) => text.includes(scenario.expected));
		await until(`Boolean(${scenario.cancelQuery})`);
		const card = await app.evaluate<{ text: string; left: number; right: number; top: number; bottom: number; buttons: { left: number; right: number; top: number; bottom: number }[] }>(`(()=>{const cancel=${scenario.cancelQuery};const c=cancel.closest('.ly-glass'),r=c.getBoundingClientRect();return {text:c.innerText,left:r.left,right:r.right,top:r.top,bottom:r.bottom,buttons:[...c.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};})()`);
		assert.ok(card.left >= 0 && card.right <= scenario.width && card.top >= 0 && card.bottom <= 800, JSON.stringify(card));
		assert.ok(card.buttons.every((b) => b.left >= card.left && b.right <= card.right && b.top >= card.top && b.bottom <= card.bottom));
		if (scenario.name === "ask_user") assert.ok(card.text.includes("保留方案 A") && card.text.includes("保留方案 B"));
		t.diagnostic(JSON.stringify({ scenario: scenario.name, badge, card })); await shot(app, `approval-${scenario.name}-${scenario.theme}-${scenario.width}`);
		await app.evaluate(`(${scenario.cancelQuery}).setAttribute('data-qa-cancel','')`);
		await click("cancel");
		await until(`!document.querySelector('button[aria-label="停止"]')`);
	}
});
