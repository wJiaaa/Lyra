/**
 * 右栏从无到有、收着时开新面板，都照展开的样子滑进来，内容区不跳；关掉最后一个照收起的样子滑出去。
 *
 * 一个标签都没有时开第一个面板，原先不走展开那一段：对话一帧缩掉 466px、正文当场重排，面板再在
 * 原地淡入，右边先空着一块。现在和展开一样，对话逐帧让出、面板从右边滑进来。反过来关掉最后一个，
 * 原先对话一帧弹回全宽、面板当场消失；现在面板先滑出去，滑完才真关。
 *
 * 新面板从右边外面滑进来（`column-slide.ts`），那一刻它的标签在窗口外。标签条原先用 `scrollIntoView`
 * 把当前标签拉进视野，而它连 `overflow: hidden` 的祖先也一起滚：1440 宽的窗口里整块内容区先被滚开
 * 173px，再随滑动一帧帧退回来，看着就是抖了一下。现在只滚标签条自己。
 *
 * 量的是对话那一格的左缘、宽度和它所有祖先的 `scrollLeft`，逐帧采样；最后一条确认标签多到放不下时，
 * 新开的那个仍然被滚进标签条的视野里——那是 `scrollIntoView` 原本要做的事。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openPane, openSession, shot } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const ID = "dock-fold-open";
const LONG = "这是一段足够长的文字，用来观察右栏展开时内容区有没有跳。".repeat(12);

let app: RunningApp;

before(async () => {
	app = await startApp({
		port: 9673,
		async seed(home) {
			const cwd = join(home, "project");
			await mkdir(cwd, { recursive: true });
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			const at = Date.now() - 600_000;
			const message = (seq: number, role: string, text: string) => ({ seq, ts: at + seq * 1000, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 } });
			const meta = { id: ID, title: "右栏展开", cwd, projectId, projectName: "演示", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0 };
			seedSessions(home, [{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", "问题"), message(3, "assistant", LONG)] as never }]);
			await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [] }));
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

interface Sample { left: number; width: number; scrolled: number; panel: number | null; opacity: number | null; text: number; textRight: number }

/** 从菜单点下 `label` 那一刻起逐帧量，滑动走完再多量几帧。菜单先开好，免得采样窗口落在等菜单上。 */
async function openWhileSampling(label: string, kind: string): Promise<Sample[]> {
	await click(app, 'button[aria-label="面板"]');
	await frames(app, 30);
	const run = app.evaluate<Sample[]>(`new Promise((resolve) => {
		const out = [];
		let n = 50;
		const f = () => {
			const conversation = document.querySelector('[data-dock-pane="conversation"]');
			const panel = document.querySelector('[data-dock-pane="${kind}"]');
			let scrolled = 0;
			for (let e = conversation; e; e = e.parentElement) scrolled = Math.max(scrolled, Math.abs(e.scrollLeft));
			const box = conversation.getBoundingClientRect();
			const column = conversation.querySelector('.ly-transcript').getBoundingClientRect();
			out.push({ left: box.left, width: box.width, scrolled, panel: panel ? panel.getBoundingClientRect().left : null, opacity: panel ? Number(getComputedStyle(panel).opacity) : null, text: column.left, textRight: column.right });
			if (--n) requestAnimationFrame(f); else resolve(out);
		};
		requestAnimationFrame(f);
	})`);
	await click(app, '[role="menuitem"]', label, "starts");
	return run;
}

/** 新面板从右边滑进来：起点在终点右边至少 200px，一路只往左走。 */
function assertSlidIn(samples: Sample[], name: string): void {
	const panels = samples.map((sample) => sample.panel).filter((left): left is number => left !== null).map(Math.round);
	assert.ok(panels.length > 10 && panels[0]! > panels.at(-1)! + 200, `${name}面板没有从右边滑进来：${panels.join(" ")}`);
	for (const [i, left] of panels.entries()) if (i) assert.ok(left <= panels[i - 1]!, `${name}面板往回退了一下：${panels.join(" ")}`);
}

/**
 * 正文那一栏的一条边一路朝终点走，不先反着跳一下。它第一帧就按终点宽度排、位置却还交给 `mx-auto` 在
 * 正滑动的格子里居中时，1440 宽的窗口开右栏，变窄的那一栏先在宽格子里居中、往右跳约 110px，再随格子
 * 变窄退回左边。左右两缘都量：宽度一下变完，总有一条边逆着走。
 */
function assertTextOneWay(texts: number[], name: string): void {
	const direction = Math.sign(texts.at(-1)! - texts[0]!);
	const back = texts.slice(1).map((left, i) => (left - texts[i]!) * direction).filter((step) => step < -0.5);
	assert.equal(back.length, 0, `${name}正文反着动了：${texts.map(Math.round).join(" ")}`);
}

test("一个标签都没有时开第一个：对话逐帧让出，面板从右边滑进来、不再原地淡入", async () => {
	await shot(app, "dock-fold-open-00-没有面板");
	const samples = await openWhileSampling("终端", "terminal");
	await frames(app, 20);
	await shot(app, "dock-fold-open-00-第一个面板");

	const widths = samples.map((sample) => Math.round(sample.width));
	const steps = widths.slice(1).map((width, i) => widths[i]! - width);
	assert.ok(widths[0]! - widths.at(-1)! > 300, `对话那一格没有让出右栏：${widths.join(" ")}`);
	assert.ok(Math.max(...steps) < 120, `对话那一格一帧缩了 ${Math.max(...steps)}px：${widths.join(" ")}`);
	assert.ok(Math.min(...steps) >= 0, `对话那一格中途又变宽了：${widths.join(" ")}`);
	assert.equal(new Set(samples.map((sample) => Math.round(sample.left))).size, 1, "对话那一格的左缘动了");
	assertSlidIn(samples, "终端");
	assertTextOneWay(samples.map((sample) => sample.text), "开第一个面板：");
	assertTextOneWay(samples.map((sample) => sample.textRight), "开第一个面板（右缘）：");
	// 和对话让出的宽度一起走：对话缩到一半时，面板已经不是透明的了。
	const half = (widths[0]! + widths.at(-1)!) / 2;
	const middle = samples.find((sample) => sample.width <= half);
	assert.ok(middle?.opacity !== null && middle!.opacity! > 0.3, `对话缩到一半时面板的不透明度是 ${middle?.opacity}`);
});

test("关掉最后一个面板：对话逐帧补回全宽，面板滑出去以后才真关", async () => {
	const run = app.evaluate<{ width: number; panel: number | null; opacity: number | null; unfold: boolean; text: number; textRight: number }[]>(`new Promise((resolve) => {
		const out = [];
		let n = 60;
		const f = () => {
			const panel = document.querySelector('[data-dock-pane="terminal"]');
			out.push({
				width: document.querySelector('[data-dock-pane="conversation"]').getBoundingClientRect().width,
				panel: panel ? panel.getBoundingClientRect().left : null,
				opacity: panel ? Number(getComputedStyle(panel).opacity) : null,
				unfold: Boolean(document.querySelector('button[aria-label="展开右侧面板"]')),
				text: document.querySelector('[data-dock-pane="conversation"] .ly-transcript').getBoundingClientRect().left,
				textRight: document.querySelector('[data-dock-pane="conversation"] .ly-transcript').getBoundingClientRect().right,
			});
			if (--n) requestAnimationFrame(f); else resolve(out);
		};
		requestAnimationFrame(f);
	})`);
	await click(app, '[data-dock-pane]:not([inert]) button[aria-label="关闭终端"]');
	const samples = await run;
	await shot(app, "dock-fold-open-00-关掉最后一个");

	const widths = samples.map((sample) => Math.round(sample.width));
	const steps = widths.slice(1).map((width, i) => width - widths[i]!);
	assert.ok(widths.at(-1)! - widths[0]! > 300, `对话那一格没有补回全宽：${widths.join(" ")}`);
	assert.ok(Math.max(...steps) < 120, `对话那一格一帧弹宽了 ${Math.max(...steps)}px：${widths.join(" ")}`);
	assert.ok(Math.min(...steps) >= 0, `对话那一格中途又变窄了：${widths.join(" ")}`);
	// 滑的那几帧面板还在，一路往右、越来越淡；滑完就卸载了。
	const sliding = samples.filter((sample) => sample.panel !== null && sample.opacity! > 0 && sample.opacity! < 1);
	assert.ok(sliding.length > 5, `面板没有滑出去：${samples.map((sample) => `${Math.round(sample.panel ?? -1)}/${sample.opacity}`).join(" ")}`);
	for (const [i, sample] of sliding.entries()) if (i) assert.ok(sample.panel! >= sliding[i - 1]!.panel!, "面板往回退了一下");
	assert.equal(samples.at(-1)!.panel, null, "滑完以后面板还挂着，没有真关");
	assert.ok(!samples.some((sample) => sample.unfold), "滑出去那一下冒出了「展开右侧面板」");
	assertTextOneWay(samples.map((sample) => sample.text), "关掉最后一个：");
	assertTextOneWay(samples.map((sample) => sample.textRight), "关掉最后一个（右缘）：");
});

test("右栏收着时开新面板：对话不跳，内容区不被滚开，新面板照样滑进来", async () => {
	await openPane(app, "终端");
	await frames(app, 40);
	await click(app, 'button[aria-label="收起右侧面板"]');
	await frames(app, 40);
	await shot(app, "dock-fold-open-01-收起");

	const samples = await openWhileSampling("文件", "files");
	await frames(app, 20);
	await shot(app, "dock-fold-open-02-展开");

	const lefts = samples.map((sample) => Math.round(sample.left));
	assert.equal(new Set(lefts).size, 1, `对话那一格的左缘逐帧：${lefts.join(" ")}`);
	const scrolled = Math.max(...samples.map((sample) => sample.scrolled));
	assert.equal(scrolled, 0, `内容区被滚开了 ${scrolled}px`);
	assertSlidIn(samples, "文件");
	assertTextOneWay(samples.map((sample) => sample.text), "展开：");
	assertTextOneWay(samples.map((sample) => sample.textRight), "展开（右缘）：");
});

test("标签多到放不下时，新开的那个滚进标签条的视野", async () => {
	for (const label of ["浏览器", "Git", "轨迹", "任务"]) {
		await openPane(app, label);
		await frames(app, 30);
	}
	const kind = await app.evaluate<string>(`document.querySelector('[data-dock-pane]:not([inert]):not([data-dock-pane="conversation"])').dataset.dockPane`);
	const fit = await app.evaluate<{ overflow: boolean; inside: boolean; detail: string }>(`(() => {
		const pane = document.querySelector('[data-dock-pane="${kind}"]');
		const tab = pane.querySelector('[data-panel-tab="${kind}"]');
		const track = tab.closest('[role="tablist"]');
		const outer = track.getBoundingClientRect();
		const inner = tab.getBoundingClientRect();
		return {
			overflow: track.scrollWidth > track.clientWidth,
			inside: inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5,
			detail: 'strip ' + outer.left + '..' + outer.right + ' tab ' + inner.left + '..' + inner.right + ' scrollLeft ' + track.scrollLeft,
		};
	})()`);
	await shot(app, "dock-fold-open-03-标签放不下");
	assert.ok(fit.overflow, `标签条没有放不下，这一条量不到东西：${fit.detail}`);
	assert.ok(fit.inside, `新开的标签不在标签条的视野里：${fit.detail}`);
});
