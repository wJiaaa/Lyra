/**
 * 侧栏开合时，右边的对话栏只动一次。
 *
 * 对话栏的宽度跟着窗格走，中间有一段平台（`dock.css` 的 `--ly-content`：窗格 992–1280px 时一直是 864）。
 * 侧栏滑动时窗格扫过这段平台，对话栏就先只平移、过了 1280 才开始变宽换行，一次点击看起来是两下。
 * 现在滑动期间宽度钉在终点（`app/hold-column-width.ts`）：第一帧就是终点宽度、之后只平移。右栏开着时
 * 终点在起点放不下，也照样第一帧到位，伸出卡片的那截被裁掉——它原先跟着窗格逐帧变宽，每变一点
 * 整段文字就重新断一次行，一次收起断了六次，看上去是文字在抖。
 *
 * 量的是转录那一栏的盒子、正文里一个字相对这一栏的位置、输入框那一栏的宽度，逐帧采样。输入框和
 * 转录量 `100cqw` 的容器不是同一个，钉错过一次：滑动开始和结束时它各自跳了 6px。
 *
 * 顶栏的标题也跟着量：它左边给红绿灯和侧栏开关的让位（`startInset`）随侧栏开合变，硬切时点下去
 * 那一帧标题先反向跳约 170px、再随整栏滑回来，看上去是一闪。
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

interface Sample { left: number; width: number; held: boolean; title: number; glyph: string; composer: number }

/** 点一下侧栏开关，逐帧量转录那一栏，直到滑动结束后再多量几帧。 */
async function slide(label: string): Promise<Sample[]> {
	const run = app.evaluate<Sample[]>(`new Promise((resolve) => {
		const out = []; const t0 = performance.now();
		const step = () => {
			const pane = document.querySelector('.ly-dock-pane[data-ly-pane-slot="conversation"]');
			const box = document.querySelector('.ly-transcript').getBoundingClientRect();
			const title = document.querySelector('[data-ly-screen-title]').getBoundingClientRect().left;
			const text = [...document.querySelectorAll('.ly-transcript *')].flatMap((el) => [...el.childNodes]).find((node) => node.nodeType === 3 && node.data.length > 200);
			const range = document.createRange(); range.setStart(text, 150); range.setEnd(text, 151);
			const at = range.getBoundingClientRect();
			const glyph = Math.round(at.left - box.left) + ',' + Math.round(at.top - box.top);
			const composer = [...pane.querySelectorAll('[class*="max-w-[var(--ly-content)]"]')].find((el) => el.querySelector('textarea, [contenteditable="true"]')).getBoundingClientRect().width;
			const held = [...pane.querySelectorAll('*')].some((el) => el.style.getPropertyValue('--ly-content'));
			out.push({ left: box.left, width: box.width, held, title, glyph, composer });
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

/**
 * 宽度在动起来的第一帧就到位，之后只平移。旧的两个方向都是宽度分好几帧变、夹着一段只平移。
 *
 * 正文只断两种行：起点的和终点的。输入框的宽度也只变一下。
 */
function assertWidthAtOnce(samples: Sample[], what: string): void {
	assertSettled(samples, what);
	const [, ...rest] = moving(samples);
	const later = rest.reduce((sum, { dw }) => sum + Math.abs(dw), 0);
	assert.ok(later < 1, `${what}：第一帧之后宽度又变了 ${later.toFixed(1)}px`);
	const layouts = samples.map(({ glyph }) => glyph).filter((glyph, index, all) => index === 0 || glyph !== all[index - 1]);
	assert.ok(layouts.length <= 2, `${what}：正文重新断了 ${layouts.length - 1} 次行（${layouts.join(" → ")}）`);
	const steps = samples.slice(1).map((sample, index) => sample.composer - samples[index].composer).filter((step) => Math.abs(step) > 0.5);
	assert.ok(steps.length <= 1, `${what}：输入框宽度变了 ${steps.length} 次（${steps.map((step) => step.toFixed(1)).join(", ")}px）`);
}

/** 标题一路朝终点走：有一帧反着动，就是先跳过去再滑回来。 */
function assertTitleOneWay(samples: Sample[], what: string): void {
	const direction = Math.sign(samples.at(-1)!.title - samples[0].title);
	assert.notEqual(direction, 0, `${what}：标题根本没动`);
	const back = samples.slice(1).map((sample, index) => (sample.title - samples[index].title) * direction).filter((step) => step < -0.5);
	assert.equal(back.length, 0, `${what}：标题反着动了 ${back.map((step) => step.toFixed(1)).join(", ")}px`);
}

test("侧栏收起与展开，顶栏标题一路滑到终点，不先反向跳一下", async () => {
	const hide = await slide("隐藏侧边栏");
	assertTitleOneWay(hide, "收起");
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertTitleOneWay(show, "展开");
	await frames(app, 30);
});

test("侧栏收起与展开，对话栏宽度不会在平移之后再变一次", async () => {
	const hide = await slide("隐藏侧边栏");
	assertWidthAtOnce(hide, "收起");
	assert.ok(hide.at(-1)!.width > hide[0].width, "收起之后对话栏应当更宽");
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertWidthAtOnce(show, "展开");
	assert.ok(Math.abs(show.at(-1)!.width - hide[0].width) < 0.5, "展开回来应当是原来的宽度");
});

test("右栏开着、终点宽度一开始放不下时，对话栏也是第一帧到位，正文不逐帧换行", async () => {
	await click(app, "button", "终端", "starts");
	await frames(app, 60);
	const hide = await slide("隐藏侧边栏");
	assertWidthAtOnce(hide, "收起");
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertWidthAtOnce(show, "展开");
	assert.ok(Math.abs(show.at(-1)!.width - hide[0].width) < 0.5, "展开回来应当是原来的宽度");
});
