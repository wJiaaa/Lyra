/**
 * 侧栏开合时，右边的对话栏只动一次。
 *
 * 对话栏的宽度跟着窗格走，中间有一段平台（`dock.css` 的 `--ly-content`：窗格 992–1280px 时一直是 864）。
 * 侧栏滑动时窗格扫过这段平台，对话栏就先只平移、过了 1280 才开始变宽换行，一次点击看起来是两下。
 * 现在滑动期间宽度钉在终点（`app/hold-column-width.ts`）：要么第一帧就是终点宽度、之后只平移，要么
 * 放不下时跟着窗格一路长到终点——总之不会在「只平移」之后再变宽。
 *
 * 量的是转录那一栏的盒子，逐帧采样；右栏开着的那一遍是「放不下终点宽度」的情形。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const ID = "sidebar-slide";
const LONG = "这是一段足够长的文字，用来观察侧栏开合时对话栏有没有分两段变化。".repeat(10);

let app: RunningApp;

before(async () => {
	app = await startApp({
		port: 9587,
		async seed(home) {
			const cwd = join(home, "project");
			await mkdir(cwd, { recursive: true });
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			const at = Date.now() - 600_000;
			const message = (seq: number, role: string, text: string) => ({ seq, ts: at + seq * 1000, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 } });
			const meta = { id: ID, title: "侧栏开合", cwd, projectId, projectName: "演示", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0 };
			seedSessions(home, [{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", "问题"), message(3, "assistant", LONG)] as never }]);
			await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [] }));
			// 1440 宽时窗格在 1114 与 1386 之间来回，正好跨过 1280 那道坎。
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 860, x: 0, y: 0 }));
		},
	});
	await frames(app, 60);
	await openSession(app, ID);
	await frames(app, 30);
});

after(async () => {
	await app?.stop();
});

interface Sample { left: number; width: number; held: boolean }

/** 点一下侧栏开关，逐帧量转录那一栏，直到滑动结束后再多量几帧。 */
async function slide(label: string): Promise<Sample[]> {
	const run = app.evaluate<Sample[]>(`new Promise((resolve) => {
		const out = []; const t0 = performance.now();
		const step = () => {
			const pane = document.querySelector('.ly-dock-pane[data-ly-pane-slot="conversation"]');
			const box = document.querySelector('.ly-transcript').getBoundingClientRect();
			out.push({ left: box.left, width: box.width, held: [...pane.children].some((c) => c.style.getPropertyValue('--ly-content')) });
			if (performance.now() - t0 < 900) requestAnimationFrame(step); else resolve(out);
		};
		requestAnimationFrame(step);
	})`);
	await click(app, "button", label, "starts");
	return run;
}

/** 有动静的那些帧：位置或宽度变过半个像素以上的。不取整，亚像素的布局取整不算动。 */
function moving(samples: Sample[]): { dl: number; dw: number }[] {
	return samples
		.slice(1)
		.map((sample, index) => ({ dl: sample.left - samples[index].left, dw: sample.width - samples[index].width }))
		.filter(({ dl, dw }) => Math.abs(dl) > 0.5 || Math.abs(dw) > 0.5);
}

function assertSettled(samples: Sample[], what: string): void {
	assert.ok(moving(samples).length > 1, `${what}：对话栏根本没动`);
	assert.equal(samples.at(-1)?.held, false, `${what}：滑完了宽度还钉着`);
}

/** 终点放得下：宽度在动起来的第一帧就到位，之后只平移。旧的两个方向都是宽度分好几帧变、夹着一段只平移。 */
function assertWidthAtOnce(samples: Sample[], what: string): void {
	assertSettled(samples, what);
	const [, ...rest] = moving(samples);
	const later = rest.reduce((sum, { dw }) => sum + Math.abs(dw), 0);
	assert.ok(later < 1, `${what}：第一帧之后宽度又变了 ${later.toFixed(1)}px`);
}

/** 终点放不下：宽度跟着窗格一路长，不许先连着几帧只平移、再接着变宽——那就是第二下。 */
function assertNoSlideThenWiden(samples: Sample[], what: string): void {
	assertSettled(samples, what);
	const frames = moving(samples);
	for (let index = 0; index + 3 < frames.length; index++) {
		const run = frames.slice(index, index + 3);
		if (!run.every(({ dl, dw }) => Math.abs(dl) > 1 && Math.abs(dw) < 0.05)) continue;
		const later = frames.slice(index + 3).reduce((sum, { dw }) => sum + Math.abs(dw), 0);
		assert.ok(later < 1, `${what}：只平移了几帧之后宽度又变了 ${later.toFixed(1)}px`);
	}
}

test("侧栏收起与展开，对话栏宽度不会在平移之后再变一次", async () => {
	const hide = await slide("隐藏侧边栏");
	assertWidthAtOnce(hide, "收起");
	assert.ok(hide.at(-1)!.width > hide[0].width, "收起之后对话栏应当更宽");
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertWidthAtOnce(show, "展开");
	assert.ok(Math.abs(show.at(-1)!.width - hide[0].width) < 0.5, "展开回来应当是原来的宽度");
});

test("右栏开着、终点宽度一开始放不下时，对话栏跟着窗格一路长过去", async () => {
	await click(app, "button", "终端", "starts");
	await frames(app, 60);
	const hide = await slide("隐藏侧边栏");
	assertNoSlideThenWiden(hide, "收起");
	await frames(app, 30);
	// 往窄里走总放得下，所以这一向仍是第一帧到位。
	const show = await slide("显示侧边栏");
	assertWidthAtOnce(show, "展开");
	assert.ok(Math.abs(show.at(-1)!.width - hide[0].width) < 0.5, "展开回来应当是原来的宽度");
});
