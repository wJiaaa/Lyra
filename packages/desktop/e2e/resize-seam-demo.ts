/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 悬停在会话列表 / 会话窗 / 右栏之间的分隔上，亮出来的是不是一整条线——边验边录。
 *
 * 量的是亮出来那条线的长度和它所在分隔条的长度；再按住拖一下，看拖动时整条变成强调色、松手后
 * 指针离开就熄掉。
 *
 * 用法：node --experimental-strip-types e2e/resize-seam-demo.ts [before|after] [输出目录]
 * `before` 只拍悬停那两张，给改动前对照用。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume分隔条整条测试");
const PORT = 9497;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "resize-seam";
const SIDEBAR = '[role="separator"][aria-label="调整侧边栏宽度"]';
const DOCK = '[data-ly-pane-dock] [role="separator"][aria-label="调整面板大小"]';

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
		appearance: { theme: "dark" },
	}));
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const meta = { id: SESSION, title: "分隔条整条", cwd: project, projectId, projectName: "project", createdAt: 1, updatedAt: 2, modelId: "none", messageCount: 1, usage: { ...zero, cost: zero }, seq: 2 };
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "看看分隔条" }], timestamp: 2 } },
		],
	} as never]);
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

/** 分隔条本身和它里面亮出来的那条线；没亮就是 null。 */
interface Seam { x: number; y: number; strip: number; line: number | null; colour: string | null }

let app: RunningApp | undefined;
const recorded: Frame[] = [];
let shotIndex = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const page = app;
	const capture = async (name: string) => {
		const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shotIndex).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	const measure = (selector: string) => page.evaluate<Seam>(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		const r = el.getBoundingClientRect();
		const line = el.querySelector("span");
		return {
			x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), strip: Math.round(r.height),
			line: line ? Math.round(line.getBoundingClientRect().height) : null,
			colour: line ? getComputedStyle(line).backgroundColor : null,
		};
	})()`);
	const move = async (x: number, y: number, buttons = 0) => {
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, ...(buttons ? { button: "left", buttons } : {}) });
		await frames(page, 10);
	};

	await until(page, `document.querySelector("[data-ly-row='${SESSION}'] > button")`, 3600);
	await openSession(page, SESSION);
	await click(page, '[data-ly-panel-quick] button[aria-label^="终端"]');
	await until(page, `document.querySelector(${JSON.stringify(DOCK)})`, 1200);
	await frames(page, 30);
	const stop = LABEL === "before" ? null : await startRecording(PORT, recorded);
	await pause(800);

	for (const [name, selector] of [["会话列表与会话窗", SIDEBAR], ["会话窗与右栏", DOCK]] as const) {
		const seam = await measure(selector);
		await move(seam.x, seam.y);
		await pause(900);
		const lit = await measure(selector);
		await capture(`悬停_${name}`);
		console.log(`${name}：`, lit);
		if (LABEL === "before") continue;

		check(`${name}：悬停时亮出来的线和分隔条一样长`, lit.line !== null && Math.abs(lit.line - lit.strip) <= 1, lit);

		// 沿着分隔条上下移动，线不跟着跑，也不灭。
		await move(seam.x, seam.y - 150);
		await pause(500);
		const slid = await measure(selector);
		check(`${name}：沿分隔条移动，线照旧是整条`, slid.line === lit.line, slid);

		// 按住拖一小段：变强调色；松手后把指针挪走，线熄掉。
		await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: seam.x, y: seam.y - 150, button: "left", buttons: 1, clickCount: 1 });
		await frames(page, 4);
		await move(seam.x - 20, seam.y - 150, 1);
		await move(seam.x - 40, seam.y - 150, 1);
		await pause(500);
		const dragging = await measure(selector);
		await capture(`拖动_${name}`);
		check(`${name}：拖动时整条换成强调色`, dragging.line === dragging.strip && dragging.colour !== lit.colour, { lit: lit.colour, dragging });
		await move(seam.x, seam.y - 150, 1);
		await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: seam.x, y: seam.y - 150, button: "left", clickCount: 1 });
		await frames(page, 4);
		await move(seam.x + 200, seam.y);
		await pause(700);
		const gone = await measure(selector);
		check(`${name}：指针离开后线熄掉`, gone.line === null, gone);
	}

	if (LABEL === "before") {
		await app.stop();
		process.exit(0);
	}
	await pause(500);
	await stop?.();

	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${STAMP}_分隔条整条_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
