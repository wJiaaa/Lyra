/**
 * 侧栏开合时，右边的对话栏一路滑到终点，读者的位置不动。
 *
 * 对话栏原先跟着窗格分档变宽（窗格 992–1280px 时一直是 864，864 处还有一道 54px 的断崖），侧栏滑过
 * 那段平台时对话栏先只平移、再变宽，边缘还会反着跳。为了盖住它，滑动期间曾由 JS 接管正文那一栏，
 * 结果和滚动锚定、跟随底部、滚动夹位轮流打架：停在底部时闪一下，往上滚开时一帧跳 123px。现在
 * `--ly-content` 是定值（`tabs.css`），宽窗口里开合只是平移；窄到要铺满时正文跟着窗格重新断行，
 * 读者的位置由滚动区自己保持（`ui/scroll/useFollowBottom.ts` 的 `keepPlace`）。
 *
 * 量的是转录那一栏的左右两缘、输入框那一栏的左右两缘，逐帧采样。
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
const READING = "reading-place";
const PARA = "这是一段足够长的文字，用来观察侧栏开合时转录的阅读位置有没有跟着跳。".repeat(4);

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
			// 段落长短不一，侧栏开合时总有几段换行变了，上面的高度才会变。
			const turns = Array.from({ length: 6 }, (_, i) => [message(2 + i * 2, "user", `问题 ${i}`), message(3 + i * 2, "assistant", `第${i}段\n\n${Array.from({ length: 8 }, (_, k) => PARA.slice(0, 60 + k * 17)).join("\n\n")}`)]).flat();
			const reading = { ...meta, id: READING, title: "阅读位置", messageCount: turns.length };
			seedSessions(home, [
				{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", "问题"), message(3, "assistant", LONG)] as never },
				{ meta: reading, records: [{ seq: 1, ts: at, type: "meta", meta: reading }, ...turns] as never },
			]);
			await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [] }));
			// 1440 宽时对话那一格在 1164 与 1430 之间来回，都比正文宽：只平移。开着右栏时它窄到要铺满，才会重新断行。
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

interface Sample { left: number; right: number; width: number; title: number; pane: number; composerLeft: number; composerRight: number }

/** 点一下侧栏开关，逐帧量转录那一栏，直到滑动结束后再多量几帧。 */
async function slide(label: string): Promise<Sample[]> {
	const run = app.evaluate<Sample[]>(`new Promise((resolve) => {
		const out = []; const t0 = performance.now();
		const step = () => {
			const pane = document.querySelector('.ly-dock-pane[data-ly-pane-slot="conversation"]');
			const box = document.querySelector('.ly-transcript').getBoundingClientRect();
			const title = document.querySelector('[data-ly-screen-title]').getBoundingClientRect().left;
			const composer = [...pane.querySelectorAll('[class*="max-w-[var(--ly-content)]"]')].find((el) => el.querySelector('textarea, [contenteditable="true"]')).getBoundingClientRect();
			out.push({ left: box.left, right: box.right, width: box.width, title, pane: pane.getBoundingClientRect().left, composerLeft: composer.left, composerRight: composer.right });
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

/**
 * 一条边一路朝终点走，也不瞬移：有一帧反着动，就是先跳过去再滑回来；某一帧走得比对话那一格的左缘
 * （它和侧栏严格同步）还远，就是跳过去的。不比前后两帧谁走得多——正文从居中定宽转成铺满时，边缘只在头几帧动，那是
 * 几何如此，不是跳。
 */
function assertEdgeSmooth(edges: number[], driver: number[], what: string): void {
	const direction = Math.sign(edges.at(-1)! - edges[0]);
	if (direction === 0) return;
	const trace = edges.map(Math.round).filter((edge, i, all) => i === 0 || edge !== all[i - 1]).join(" ");
	const steps = edges.slice(1).map((edge, i) => ({ step: (edge - edges[i]) * direction, lead: Math.abs(driver[i + 1] - driver[i]) }));
	assert.ok(steps.every(({ step }) => step > -0.5), `${what}反着动了：${trace}`);
	const leap = steps.find(({ step, lead }) => step > lead + 1);
	assert.ok(!leap, `${what}一帧跳了 ${leap?.step.toFixed(1)}px，侧栏这一帧只走了 ${leap?.lead.toFixed(1)}px：${trace}`);
}

/**
 * 一次点击是一个动作：宽度从起点一气变到终点，中间不停下来只平移；左右两缘、输入框两缘都一路朝终点走。
 */
function assertOneMotion(samples: Sample[], what: string): void {
	assert.ok(moving(samples).length > 1, `${what}：对话栏根本没动`);
	const widening = samples.slice(1).map((sample, i) => Math.abs(sample.width - samples[i].width) > 0.5);
	const first = widening.indexOf(true);
	const last = widening.lastIndexOf(true);
	if (first >= 0) assert.ok(widening.slice(first, last + 1).every(Boolean), `${what}：宽度变到一半停了几帧又接着变`);
	const driver = samples.map(({ pane }) => pane);
	assertEdgeSmooth(samples.map(({ left }) => left), driver, `${what}：正文左缘`);
	assertEdgeSmooth(samples.map(({ right }) => right), driver, `${what}：正文右缘`);
	assertEdgeSmooth(samples.map(({ composerLeft }) => composerLeft), driver, `${what}：输入框左缘`);
	assertEdgeSmooth(samples.map(({ composerRight }) => composerRight), driver, `${what}：输入框右缘`);
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

test("宽窗口里开合侧栏，对话栏只平移、不重新断行，左右两边一路走到终点", async () => {
	const hide = await slide("隐藏侧边栏");
	assertOneMotion(hide, "收起");
	assert.ok(hide.every(({ width }) => Math.abs(width - hide[0].width) < 0.5), `收起：对话栏宽度变了 ${hide[0].width} → ${hide.at(-1)!.width}`);
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertOneMotion(show, "展开");
	assert.ok(show.every(({ width }) => Math.abs(width - hide[0].width) < 0.5), `展开：对话栏宽度变了 ${hide[0].width} → ${show.at(-1)!.width}`);
});

test("右栏开着时，对话栏一路走到终点，宽度不中途停下，左右两边都不反着跳", async () => {
	await click(app, "button", "终端", "starts");
	await frames(app, 60);
	const hide = await slide("隐藏侧边栏");
	assertOneMotion(hide, "收起");
	await frames(app, 30);
	const show = await slide("显示侧边栏");
	assertOneMotion(show, "展开");
	assert.ok(Math.abs(show.at(-1)!.width - hide[0].width) < 0.5, "展开回来应当是原来的宽度");
});

const VIEW = `document.querySelector('.ly-dock-pane[data-ly-pane-slot="conversation"] .ly-scroll-view')`;

/**
 * 点一下侧栏开关，逐帧量读者正在读的那一段：视口里第一个从顶边开始的段落。再往下的段落会随中间
 * 那些重新断行挪动，这是断行本身，不是跳。
 */
async function readingSlide(label: string): Promise<number[]> {
	const run = app.evaluate<number[]>(`new Promise((resolve) => {
		const out = []; const t0 = performance.now();
		const top = ${VIEW}.getBoundingClientRect().top;
		const mark = [...document.querySelectorAll('.ly-transcript p')].find((p) => p.getBoundingClientRect().top >= top);
		// 画完这一帧再量：帧回调里量到的是还没把阅读位置挪回去的布局。
		const step = () => setTimeout(() => {
			out.push(mark.getBoundingClientRect().top);
			if (performance.now() - t0 < 900) requestAnimationFrame(step); else resolve(out);
		});
		requestAnimationFrame(step);
	})`);
	await click(app, "button", label, "starts");
	return run;
}

/**
 * 点一下侧栏开关，记下滑动期间每一次滚动时转录离底部多远。
 *
 * 在 capture 阶段听，赶在跟随底部的 `onScroll` 把它拉回去之前。按帧量不够：内容少时那一下拉回落在
 * 同一帧里、画面上看不见，真实会话的帧重一些，就晚一帧，画出来一次。
 */
async function bottomSlide(label: string): Promise<number[]> {
	const run = app.evaluate<number[]>(`new Promise((resolve) => {
		const view = ${VIEW}; const out = [];
		const listen = (event) => { if (event.target === view) out.push(Math.round(view.scrollHeight - view.scrollTop - view.clientHeight)); };
		document.addEventListener('scroll', listen, true);
		setTimeout(() => { document.removeEventListener('scroll', listen, true); resolve(out); }, 900);
	})`);
	await click(app, "button", label, "starts");
	return run;
}

/** 换到长转录，开着右栏：对话那一格窄到正文要跟着重新断行。 */
async function openNarrowReading(): Promise<void> {
	await openSession(app, READING);
	await frames(app, 30);
	if (!(await app.evaluate<boolean>(`!!document.querySelector('[data-dock-pane="terminal"]:not([inert])')`))) await click(app, "button", "终端", "starts");
	await frames(app, 60);
}

/*
 * 正文重新断行时内容高度在变。停在底部的转录每一帧都要还在底部：曾经有一版在动画开始时把滑动拨到
 * 终点量尺寸，`scrollTop` 在那一次布局里被夹到终点的最大值，真实会话里第一帧离底部 221px，下一帧
 * 才被跟随底部拉回来，看上去是闪了一下。
 */
test("停在底部时开合侧栏，每一帧都贴着底", async () => {
	await openNarrowReading();
	const away: string[] = [];
	for (const label of ["隐藏侧边栏", "显示侧边栏"]) {
		const distances = await bottomSlide(label);
		if (distances.some((d) => d > 1)) away.push(`${label}：滚到过离底部 ${[...new Set(distances)].join(" ")}px 的地方`);
		await frames(app, 30);
	}
	assert.deepEqual(away, []);
});

/*
 * 正文那一栏的 `max-width` 一变，浏览器的滚动锚定就整段不调：停在离底部 150px 处收起侧栏，上面的
 * 段落换行变少、整体变矮，画面一帧往上跳 123px、几乎贴底，展开再跳回来。
 */
test("往上滚开之后开合侧栏，眼前那一段不跟着正文重新断行上下跳", async () => {
	await openNarrowReading();
	await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: -150 });
	await frames(app, 60);
	const away = await app.evaluate<number>(`(() => { const v = ${VIEW}; return v.scrollHeight - v.scrollTop - v.clientHeight; })()`);
	assert.ok(away > 100, `没滚开：离底部只有 ${away}px`);
	const heights: number[] = [];
	const drifts: string[] = [];
	for (const label of ["隐藏侧边栏", "显示侧边栏"]) {
		heights.push(await app.evaluate<number>(`${VIEW}.scrollHeight`));
		const tops = await readingSlide(label);
		const drift = tops.map((top) => Math.round(top - tops[0]));
		if (drift.some((d) => Math.abs(d) > 1)) drifts.push(`${label}：眼前那一段跟着跳了 ${[...new Set(drift)].join(" ")}px`);
		await frames(app, 30);
	}
	assert.notEqual(heights[0], heights[1], "侧栏开合时转录的高度没变，这条量不到要量的东西");
	assert.deepEqual(drifts, []);
});
