/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 对话里划一段拿去侧边聊天问、引用到输入框，以及 `/btw`——在真窗口里用真鼠标划、真键盘打，边验边录。
 *
 * 模型是本地的假服务：只看侧边聊天有没有被问到、主会话有没有被打扰，不在乎答了什么。
 *
 * 用法：node --experimental-strip-types e2e/quote-aside-demo.ts [输出目录]
 */

import { mkdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, dragSelect, frames, openSession, press, shot, textSpan, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume划词侧边聊天测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;

const MAIN = '[data-ly-chat-surface="conversation"]';
const QUOTABLE = `${MAIN} [data-ly-quote]`;
const MENU = '[data-ly-popover][role="menu"]';
const COMPOSER = `${MAIN} textarea`;
const SIDE_FIELD = '[data-dock-pane^="chat"]:not([inert]) textarea';
const CHAT_TABS = `[...new Set([...document.querySelectorAll('[data-panel-tab^="chat"]')].map(e=>e.dataset.panelTab))].length`;
const SIDE_ANSWER = "旁问收到：这一轮在核对滚动位置。";
const BTW = "这一轮在干什么";

let app: RunningApp;
const requests: { side: boolean; text: string }[] = [];
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what, saw: JSON.stringify(saw) });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

function answer(res: ServerResponse, text: string) {
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: "qa", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw);
		const side = Boolean(body.tools?.some((tool: { name: string }) => tool.name === "read_main_chat"));
		requests.push({ side, text: JSON.stringify(body.messages ?? []) });
		res.writeHead(200, { "content-type": "text/event-stream" });
		answer(res, side ? SIDE_ANSWER : "主会话不该被问到。");
	});
});

/**
 * 菜单挂在选区上，不挂鼠标：横中线对齐选区的横中线，下沿在选区上沿上方 8px（`Popover` 的 `GAP`）。
 *
 * 挂鼠标那一点时，同一次划选从左往右划和从右往左划，菜单会落在两个地方。
 */
const menuPlacement = () =>
	app.evaluate<{
		menu: { left: number; top: number; right: number; bottom: number };
		selection: { left: number; top: number; right: number; bottom: number };
		centered: boolean;
		above: boolean;
	} | null>(
		`(()=>{const m=document.querySelector('${MENU}');if(!m)return null;
		 const r=m.getBoundingClientRect();const s=getSelection().getRangeAt(0).getBoundingClientRect();
		 const mid=(x)=>x.left+x.width/2;
		 return {menu:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},
			selection:{left:s.left,top:s.top,right:s.right,bottom:s.bottom},
			centered:Math.abs(mid(r)-mid(s))<1,above:Math.abs(r.bottom+8-s.top)<1};})()`,
	);

async function run(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("假模型没起来");
	app = await startApp({ port: PORT, seed: (home) => seedInteractions(home, address.port) });
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await openSession(app, "qa-short");
		await until(app, `document.querySelector('${QUOTABLE}')`);
		await frames(app, 30);
		await pause(800);

		console.log("\n1. 划一段回复，菜单压在选区上方、对着它的中线");
		const first = await textSpan(app, QUOTABLE, "隔离测试文本");
		await dragSelect(app, first.start, first.end);
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 12);
		const placed = await menuPlacement();
		check("菜单压在选区上方、横向居中于选区", Boolean(placed?.centered && placed.above), placed);
		const items = await app.evaluate<string[]>(`[...document.querySelectorAll('${MENU} [role="menuitem"]')].map(e=>e.textContent.trim())`);
		check("菜单里是「在侧边聊天中提问」「引用到输入框」", items.join("|") === "在侧边聊天中提问|引用到输入框", items);
		/*
		 * 形状照 ZCode 的 `SelectionActionMenu`：两段并排、中间夹一条通高的 1px 线，字号取界面字号
		 * 小一号的那档——所以高度是一条 30 来像素的胶囊，不是菜单行那 32px 的一行。
		 */
		const bar = await app.evaluate<{ heights: number[]; tops: number[]; lefts: number[]; rights: number[]; dividers: number[] }>(
			`(()=>{const items=[...document.querySelectorAll('${MENU} [role="menuitem"]')];const r=items.map(e=>e.getBoundingClientRect());
			 const dividers=[...document.querySelectorAll('${MENU} div')]
				.map(e=>e.getBoundingClientRect()).filter(x=>Math.round(x.width)===1)
				.map(x=>Math.round(x.height));
			 return {heights:r.map(x=>Math.round(x.height)),tops:r.map(x=>Math.round(x.top)),lefts:r.map(x=>Math.round(x.left)),
			 rights:r.map(x=>Math.round(x.right)),dividers};})()`,
		);
		check("菜单是横排的一条：两段同高、并列", bar.tops[0] === bar.tops[1] && bar.heights[0] === bar.heights[1] && bar.rights[0] <= bar.lefts[1], bar);
		check("两段之间夹着一条通高的 1px 分隔线", bar.dividers.length === 1 && bar.dividers[0] === bar.heights[0], bar.dividers);
		check("一条矮的胶囊，不是菜单行那么高", bar.heights[0] < 32, bar.heights);
		await shot(app, `${STAMP}_01_划词后菜单在鼠标处`);
		await pause(1000);

		console.log("\n2. 在侧边聊天中提问：开出侧边聊天，引文在输入框里，光标在后面");
		await click(app, `${MENU} [role="menuitem"]`, "在侧边聊天中提问");
		await until(app, `document.querySelector('${SIDE_FIELD}')?.value`);
		await frames(app, 20);
		const seeded = await app.evaluate<{ value: string; focused: boolean; caret: number }>(
			`(()=>{const e=document.querySelector('${SIDE_FIELD}');return {value:e.value,focused:e===document.activeElement,caret:e.selectionStart};})()`,
		);
		check("侧边输入框里是引用块，后面空一行", seeded.value === "> 隔离测试文本\n\n", seeded.value);
		check("光标在侧边输入框末尾", seeded.focused && seeded.caret === seeded.value.length, seeded);
		check("菜单收起了", !(await app.evaluate<boolean>(`Boolean(document.querySelector('${MENU}'))`)), "还在");
		check("没有发出任何请求——只放进输入框，不替人问", requests.length === 0, requests.length);
		await shot(app, `${STAMP}_02_引文落进侧边聊天输入框`);
		await pause(1000);

		console.log("\n3. 再划一段：前台就是这格侧边聊天，接在后面，不另开");
		const second = await textSpan(app, QUOTABLE, "第 5 个回答");
		await dragSelect(app, second.start, second.end);
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 12);
		await click(app, `${MENU} [role="menuitem"]`, "在侧边聊天中提问");
		await until(app, `document.querySelector('${SIDE_FIELD}')?.value.includes('第 5 个回答')`);
		const both = await app.evaluate<string>(`document.querySelector('${SIDE_FIELD}').value`);
		check("两段引文都在同一个输入框里", both === "> 隔离测试文本\n\n> 第 5 个回答\n\n", both);
		check("右栏仍只有一格侧边聊天", (await app.evaluate<number>(CHAT_TABS)) === 1, await app.evaluate<number>(CHAT_TABS));
		await shot(app, `${STAMP}_03_第二段接在同一格`);
		await pause(1000);

		console.log("\n4. 跨了两条消息的选区不弹菜单");
		const question = await textSpan(app, `${MAIN} [data-question-index]`, "第 5 个问题");
		const reply = await textSpan(app, QUOTABLE, "第 5 个回答");
		await dragSelect(app, question.start, reply.end);
		await frames(app, 20);
		const crossed = await app.evaluate<{ selected: string; menu: boolean }>(`({selected:getSelection().toString(),menu:Boolean(document.querySelector('${MENU}'))})`);
		check("选区确实跨了问题和回答", crossed.selected.includes("第 5 个问题") && crossed.selected.includes("第 5 个回答"), crossed.selected.slice(0, 60));
		check("跨消息时没有菜单", !crossed.menu, crossed);
		await shot(app, `${STAMP}_04_跨消息不弹菜单`);
		await pause(1000);

		console.log("\n5. 引用到输入框：落进主输入框，光标在后面");
		const third = await textSpan(app, QUOTABLE, "稳定布局");
		await dragSelect(app, third.start, third.end);
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 12);
		await click(app, `${MENU} [role="menuitem"]`, "引用到输入框");
		await until(app, `document.querySelector('${COMPOSER}')?.value`);
		await frames(app, 20);
		const main = await app.evaluate<{ value: string; focused: boolean; caret: number }>(
			`(()=>{const e=document.querySelector('${COMPOSER}');return {value:e.value,focused:e===document.activeElement,caret:e.selectionStart};})()`,
		);
		check("主输入框里是引用块", main.value === "> 稳定布局\n\n", main.value);
		check("光标在主输入框末尾", main.focused && main.caret === main.value.length, main);
		check("侧边聊天那边没被动到", (await app.evaluate<string>(`document.querySelector('${SIDE_FIELD}').value`)) === both, "变了");
		await shot(app, `${STAMP}_05_引用到主输入框`);
		await pause(1000);

		console.log("\n6. 打 / 能看到 btw");
		await type(app, COMPOSER, "/bt");
		await until(app, `[...document.querySelectorAll('[data-command-kind="builtin"]')].some(e=>e.getAttribute('aria-label')?.startsWith('btw'))`);
		await frames(app, 12);
		const listed = await app.evaluate<string>(`[...document.querySelectorAll('[data-command-kind="builtin"]')].map(e=>e.getAttribute('aria-label')).find(l=>l.startsWith('btw'))`);
		check("命令菜单里有 /btw 和它的说明", listed.includes("另开一个侧边聊天问这句话"), listed);
		await shot(app, `${STAMP}_06_命令菜单里的btw`);
		await pause(1000);

		console.log("\n7. /btw 一句话：新开一格侧边聊天问出去，主对话里什么也不留");
		const asked = await app.evaluate<number>(`document.querySelectorAll('${MAIN} [data-question-index]').length`);
		await type(app, COMPOSER, `/btw ${BTW}`);
		await frames(app, 6);
		await press(app, "Enter", 13);
		await until(app, `${CHAT_TABS}===2`);
		await until(app, `[...document.querySelectorAll('[data-dock-pane^="chat"]:not([inert]) [data-ly-chat-surface="side-chat"]')].some(e=>e.textContent.includes(${JSON.stringify(SIDE_ANSWER)}))`);
		await frames(app, 20);
		check("新开了第二格侧边聊天", (await app.evaluate<number>(CHAT_TABS)) === 2, await app.evaluate<number>(CHAT_TABS));
		const sideText = await app.evaluate<string>(`document.querySelector('[data-dock-pane^="chat"]:not([inert]) [data-ly-chat-surface="side-chat"]').textContent`);
		check("那一格里是这句问话和回答", sideText.includes(BTW) && sideText.includes(SIDE_ANSWER) && !sideText.includes("/btw"), sideText.slice(0, 80));
		check("问的是侧边聊天，主会话一次也没被请求", requests.length === 1 && requests[0].side && requests[0].text.includes(BTW), requests.map((each) => ({ side: each.side, asked: each.text.includes(BTW) })));
		check("主对话里没有多出一条", (await app.evaluate<number>(`document.querySelectorAll('${MAIN} [data-question-index]').length`)) === asked, asked);
		check("主输入框清空了", (await app.evaluate<string>(`document.querySelector('${COMPOSER}').value`)) === "", "没清");
		await shot(app, `${STAMP}_07_btw开出新一格`);
		await pause(1500);
	} finally {
		await stop();
	}
	const passed = checks.filter((each) => each.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，采到 ${recorded.length} 帧`);
	await app.stop();
	app = undefined as unknown as RunningApp;
	if (recorded.length > 0) await encode(recorded, join(OUT_DIR, `${STAMP}_划词与btw_${passed}of${checks.length}.mp4`), 60, 1200);
	if (passed !== checks.length) process.exitCode = 1;
}

run()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await app?.stop().catch(() => {});
		await closeListeningServer(server).catch(() => {});
	});
