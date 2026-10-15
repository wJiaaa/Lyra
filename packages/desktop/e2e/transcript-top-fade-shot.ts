/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 转录顶上那一道渐隐，压在一张浅色图上时长什么样。
 *
 * 深色主题里，浅色的东西（图片、预览卡）滚到顶边，被遮罩把 alpha 收下去，透出来的是深色底——
 * 那一段看上去不是「化开」，是一道发脏的暗带。这里把一张奶油色的图停在顶边下一半，拍顶部那一条，
 * 顺带量顶边往下每隔几像素的亮度，看暗带有多深、拖多长。
 *
 * `pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/transcript-top-fade-shot.ts [输出目录] [标签]`
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { frames, openSession, until } from "./drive.ts";
import { seedSessions, type FixtureRecord } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume会话顶部渐隐测试");
const LABEL = process.argv[3] ?? "当前";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "top-fade";
const WIDTH = 640;
const HEIGHT = 360;

/** 和截图里那张待办卡片差不多的奶油色，一块纯色：暗带在纯色上最显。 */
function creamPng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < HEIGHT; y++) {
		rows.push(0);
		for (let x = 0; x < WIDTH; x++) rows.push(250, 243, 228);
	}
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(WIDTH, 0);
	ihdr.writeUInt32BE(HEIGHT, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows), { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const png = creamPng().toString("base64");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const base = Date.now() - 3600_000;
	let clock = base;
	const at = () => (clock += 60_000);
	const prose = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段：这是一段用来撑出滚动高度的正文，顶边压在字上和压在图上是两回事。`).join("\n\n");
	const messages = [
		{ role: "user", content: [{ type: "text", text: "开头" }], timestamp: at() },
		{ role: "assistant", content: [{ type: "text", text: prose }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: at() },
		{ role: "user", content: [{ type: "text", text: "看看这张" }, { type: "image", data: png, mimeType: "image/png" }], timestamp: at() },
		{ role: "assistant", content: [{ type: "text", text: prose }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: at() },
	];
	const meta = { id: SESSION, title: "顶部渐隐", cwd, projectId, projectName: "project", createdAt: base, updatedAt: clock, modelId: "qa/model", messageCount: messages.length, usage, seq: 0 };
	const records: FixtureRecord[] = [{ type: "meta", meta, seq: 0, ts: base } as FixtureRecord];
	for (const message of messages) records.push({ type: "message", message, ts: message.timestamp } as FixtureRecord);
	seedSessions(home, [{ meta: meta as never, records }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 60, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [],
		defaultModelId: null,
		autoSummarizeTitle: false,
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "project", pinned: true, lastOpenedAt: 1 }],
	}));
}

const renderer = await startDevRenderer();
const app = await startApp({ port: 9531, seed, rendererUrl: renderer.url });
try {
	await openSession(app, SESSION);
	const image = 'main .ly-scroll-host img[src]';
	// 缩略图是懒加载的，先滚到它跟前。
	await until(app, `document.querySelector(${JSON.stringify(image)})`);
	await app.evaluate(`document.querySelector(${JSON.stringify(image)}).scrollIntoView({ block: "center" })`);
	await until(app, `document.querySelector(${JSON.stringify(image)})?.complete && document.querySelector(${JSON.stringify(image)}).naturalWidth > 0`);
	await frames(app, 30);

	// 把图的上沿推到视口上沿之上 10px：图的上半截正好跨在渐隐那一段里。
	const box = await app.evaluate<{ top: number; left: number; width: number; fade: string }>(`(() => {
		const img = document.querySelector(${JSON.stringify(image)});
		const viewport = img.closest(".ly-scroll-host").firstElementChild;
		viewport.scrollTop += img.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 10;
		const v = viewport.getBoundingClientRect();
		return { top: v.top, left: v.left, width: v.width, fade: "" };
	})()`);
	// 第三个参数临时覆盖渐隐深度，用来在同一画面上比较几种写法。
	const depth = process.argv[4];
	if (depth) await app.evaluate(`document.querySelector("main .ly-fade-y").style.setProperty("--ly-fade-top", ${JSON.stringify(depth)})`);
	await new Promise((r) => setTimeout(r, 600));
	const fade = await app.evaluate<string>(`(() => { const s = getComputedStyle(document.querySelector("main .ly-fade-y")); return s.getPropertyValue("--ly-fade-top").trim() + "，--ly-fade-bottom = " + s.getPropertyValue("--ly-fade-bottom").trim(); })()`);

	const clip = { x: box.left, y: Math.max(0, box.top - 40), width: box.width, height: 160, scale: 2 };
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip });
	await mkdir(OUT_DIR, { recursive: true });
	const file = join(OUT_DIR, `${STAMP}_${LABEL}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	// 整窗一张，底部挨着输入框的那一头也在里面。
	const whole = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_整窗.png`), Buffer.from(whole.data, "base64"));

	// 图中间那一列，从视口上沿往下每 4px 的亮度：渐隐的形状就是这一串数。
	const column = await app.evaluate<number[]>(`(async () => {
		const img = document.querySelector(${JSON.stringify(image)});
		const r = img.getBoundingClientRect();
		return [Math.round(r.left + r.width / 2), Math.round(${box.top})];
	})()`);
	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: column[0], y: column[1], width: 1, height: 48, scale: 1 } });
	const luma = await app.evaluate<number[]>(`(async () => {
		const bytes = Uint8Array.from(atob("${shot.data}"), (ch) => ch.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const c = new OffscreenCanvas(1, bitmap.height);
		const g = c.getContext("2d");
		g.drawImage(bitmap, 0, 0);
		const d = g.getImageData(0, 0, 1, bitmap.height).data;
		const out = [];
		for (let y = 0; y < bitmap.height; y += 4) out.push(Math.round(0.2126 * d[y * 4] + 0.7152 * d[y * 4 + 1] + 0.0722 * d[y * 4 + 2]));
		return out;
	})()`);
	console.log(`--ly-fade-top = ${fade.trim()}`);
	// 输入框上方叠着东西时，输入框条要把 12px 上边距要回来；只有转录在上面时是 0。
	// 插的是和真组件同一层、带同一个标记的元素：量的是选择器和层级，不是那几样东西本身的样子。
	console.log(await app.evaluate<string>(`(() => {
		const dock = document.querySelector("main .ly-composer-dock");
		const cases = {
			"只有转录": "",
			"空的任务清单层": '<div data-ly-task-inline=""></div>',
			"审批卡片": '<div data-approval-region=""></div>',
			"Hook 提示条": '<div><div><div data-ly-hook-trust-banner=""></div></div></div>',
			"任务清单": '<div data-ly-task-inline=""><div data-ly-task-list=""></div></div>',
		};
		return Object.entries(cases).map(([name, html]) => {
			const holder = document.createElement("template");
			holder.innerHTML = html;
			const node = holder.content.firstElementChild;
			if (node) dock.before(node);
			const top = getComputedStyle(dock).paddingTop;
			node?.remove();
			return name + " " + top;
		}).join("，");
	})()`));
	// 转录最后一行字和输入框卡片之间那段空白，由哪几块组成。
	console.log(await app.evaluate<string>(`(() => {
		const view = document.querySelector("main .ly-fade-y");
		const dock = document.querySelector("main .ly-composer-dock");
		const card = dock.querySelector(".ly-composer");
		const v = view.getBoundingClientRect(), d = dock.getBoundingClientRect(), c = card.getBoundingClientRect();
		const inner = view.firstElementChild;
		return "视口下沿 " + v.bottom + "，输入框条上沿 " + d.top + "（padding-top " + getComputedStyle(dock).paddingTop + "），卡片上沿 " + c.top
			+ "；转录内容 padding-bottom " + getComputedStyle(view).paddingBottom + " / " + (inner ? getComputedStyle(inner).paddingBottom : "-");
	})()`));
	console.log(`图中线，从顶边往下每 4px 的亮度：${luma.join(" ")}`);
	console.log(`截图：${file}`);
} finally {
	await app.stop();
	await renderer.close();
}
