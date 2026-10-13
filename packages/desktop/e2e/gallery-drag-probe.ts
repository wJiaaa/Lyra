/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 画廊里点开一张图后，顶上那一行（返回、页码、上一张 / 下一张）和右栏顶上的对话标题点得到，不被窗口的拖拽区吃掉。
 *
 * 详情盖在 SoloScreen 上，顶上 44px 是拖窗口的区域；拖拽区按矩形算、不看层级，控件不挖洞，人的鼠标
 * 在那儿只会拖动窗口。CDP 的点击绕过这次判定，所以量的是 `dragRegionAt`，点击只用来确认按下去有反应。
 *
 *   node --experimental-strip-types e2e/gallery-drag-probe.ts   # 截图写到 ~/Desktop/Plume画廊测试
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../core/src/session/store.ts";
import type { Message } from "../../core/src/types/message.ts";
import { startApp, type RunningApp } from "./app.ts";
import { click, dragRegionAt, until } from "./drive.ts";
import { pause } from "./record.ts";

const PORT = 9454;
const OUT = join(homedir(), "Desktop", "Plume画廊测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}\n     ${detail}`);
}

let app: RunningApp;
async function shot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT, `${stamp}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   📸 ${file}`);
}

/** 三张颜色不同的 16:9 图：字节不同，名字（内容哈希）就不同。 */
async function pictures(): Promise<Buffer[]> {
	const dir = await mkdtemp(join(tmpdir(), "plume-gallery-probe-"));
	const out: Buffer[] = [];
	for (const color of ["0x3b82f6", "0x1e1b4b", "0xf97316"]) {
		const file = join(dir, `${color}.png`);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", file]);
		out.push(await readFile(file));
	}
	await rm(dir, { recursive: true, force: true });
	return out;
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({ uiLocale: "zh-CN", projectMemory: false, autoSummarizeTitle: false, mcpServers: [], hooks: [], appearance: { theme: "light" }, projects: [{ path: cwd, name: "画廊演示", pinned: true, lastOpenedAt: Date.now() }] }),
	);
	await mkdir(join(home, "session-media"), { recursive: true });
	const names: string[] = [];
	for (const bytes of await pictures()) {
		const name = `${createHash("sha1").update(bytes).digest("hex")}.png`;
		await writeFile(join(home, "session-media", name), bytes);
		names.push(name);
	}
	const store = new SessionStore(join(home, "sessions"));
	const meta = await store.create(cwd, "relay/img", "画一只纸船");
	let clock = Date.now() - 60_000;
	const asks = ["画一只红色纸船", "改成夜晚", "改成黄昏"];
	for (const [index, media] of names.entries()) {
		const id = `call_${index}`;
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: asks[index] }], timestamp: (clock += 1000) },
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "image_generate", arguments: { prompt: asks[index], ...(index ? { images: ["#1"] } : {}) } }],
				api: "openai-chat-completions",
				provider: "relay",
				model: "img",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: (clock += 1000),
			} as Message,
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "image_generate",
				content: [{ type: "text", text: "Drew." }],
				details: { kind: "image_generate", model: "relay/img", modelName: "img", count: 1, edit: index > 0, startedAt: clock, images: [{ media, mimeType: "image/png", width: 640, height: 360 }] },
				isError: false,
				timestamp: (clock += 3000),
			},
		];
		for (const message of messages) await store.append(meta, { type: "message", message });
	}
}

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	try {
		await app.evaluate("document.fonts.ready");
		await click(app, "button", "画廊", "exact");
		await until(app, `document.querySelectorAll("[data-ly-gallery-tile]").length === 3`);
		await pause(600);
		await shot("01_画廊");
		await click(app, "[data-ly-gallery-tile]");
		await until(app, `document.querySelector("[data-ly-gallery-detail]")`);
		await pause(900);
		await shot("02_点开一张");

		for (const [label, selector] of [
			["返回", "[data-ly-gallery-close]"],
			["上一张", 'button[aria-label="上一张"]'],
			["下一张", 'button[aria-label="下一张"]'],
			["对话标题", "[data-ly-gallery-session]"],
		] as const) {
			const region = await dragRegionAt(app, selector);
			check(`「${label}」在原生窗口看来是能点的，不是拖窗口的地方`, region === "clickable", region);
		}
		// 空白处仍然能拖窗口：只给控件挖洞，不是整行。
		const blank = await app.evaluate<string>(`(()=>{const row=document.querySelector("[data-ly-gallery-close]").parentElement;const r=row.getBoundingClientRect();const el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);el.setAttribute("data-probe-blank","");return el.tagName})()`);
		const blankRegion = await dragRegionAt(app, "[data-probe-blank]");
		check("这一行中间的空白处仍然能拖动窗口", blankRegion === "drag", `${blank} → ${blankRegion}`);

		const before = await app.evaluate<string>(`document.querySelector("[data-ly-gallery-detail]").getAttribute("data-ly-gallery-detail")`);
		await click(app, 'button[aria-label="下一张"]');
		await pause(700);
		const after = await app.evaluate<string>(`document.querySelector("[data-ly-gallery-detail]").getAttribute("data-ly-gallery-detail")`);
		check("按「下一张」换了图", before !== after, `${before.slice(0, 8)} → ${after.slice(0, 8)}`);
		await shot("03_下一张");
	} catch (error) {
		console.log(`💥 ${error instanceof Error ? error.message : String(error)}`);
		await shot("失败现场").catch(() => {});
		check("探针跑完了全程", false, error instanceof Error ? error.message : String(error));
	} finally {
		await app.stop();
		const passed = results.filter((result) => result.ok).length;
		console.log(`\n${passed}/${results.length} 通过`);
		if (passed !== results.length) process.exitCode = 1;
	}
}

await main();
