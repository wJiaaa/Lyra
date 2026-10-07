/* oxlint-disable no-console -- 输出真实窗口的动画测量结果 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, shot, until } from "./drive.ts";
import { encode, frameGrabber, startRecording, type Frame } from "./record.ts";
import { fixtureStore } from "./session-fixture.ts";

const PROJECT = "图标测试";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);
const FOLDER = `[data-ly-project="${PROJECT}"] button[aria-expanded]`;
const MORE = 'button[class~="group/more"]';
// 列表最上面那一行的归档按钮。七段会话同一毫秒建出来，谁排第几不固定，按名字找可能找到被折起来的那段。
const ARCHIVE = '[data-ly-row] button[aria-label^="归档会话「"]';
const TARGETS: [string, string][] = [
	["项目文件夹", FOLDER],
	["项目新对话", `button[aria-label="在「${PROJECT}」里新建会话"]`],
	["新建项目", 'button[aria-label="新建项目"]'],
	["分组箭头", '[data-ly-section="projects"]'],
	["归档会话", ARCHIVE],
	["显示更多", MORE],
];

// 图标画面上能看到的一切：每个元素的变换矩阵，以及会被动画改写的路径和线段端点。
const state = (selector: string) => `JSON.stringify((s=>[s,...s.querySelectorAll('*')])(document.querySelector('${selector} svg')).map(e=>{
	const t=getComputedStyle(e).transform,m=new DOMMatrix(t==='none'?undefined:t);
	return [m.a,m.b,m.c,m.d,m.e,m.f,e.getAttribute('d'),e.getAttribute('y1'),e.getAttribute('y2')];
}))`;
// 同一姿态：路径和端点一字不差，变换差在 0.5px 以内。上游 chevron 的复位沿用了三段关键帧的
// `times`，停下时离原位还有 0.05px 左右，每次不同；按字符串比就永远对不上。
const near = (now: string, resting: string) => `(()=>{const a=JSON.parse(${now}),b=${resting};
	return a.length===b.length&&a.every((x,i)=>x.every((v,j)=>typeof v==='number'?Math.abs(v-b[i][j])<0.5:v===b[i][j]));
})()`;

function samePose(now: string, resting: string): boolean {
	const a = JSON.parse(now) as unknown[][], b = JSON.parse(resting) as unknown[][];
	return a.length === b.length && a.every((x, i) => x.every((v, j) => typeof v === "number" ? Math.abs(v - (b[i]![j] as number)) < 0.5 : v === b[i]![j]));
}

interface Sample { state: string; box: string }

async function sample(app: RunningApp, selector: string, duration = 1000): Promise<Sample[]> {
	return app.evaluate(`new Promise(resolve=>{
		const samples=[],start=performance.now();
		const measure=()=>{
			const host=document.querySelector('${selector}'),wrap=host.querySelector('svg').parentElement;
			samples.push({state:${state(selector)},box:[host,wrap].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}).join()});
			if(performance.now()-start>=${duration})resolve(samples);else requestAnimationFrame(measure);
		};requestAnimationFrame(measure);
	})`);
}

test("会话列表里的 lucide-animated 图标悬停播放、移出复位，点击行为不变", async () => {
	const app = await startApp({
		port: 9895,
		seed: async (home) => {
			const store = fixtureStore(home);
			let projectId: string;
			try {
				const archived = await store.create(home, "fake/model", "已归档会话");
				projectId = archived.projectId;
				for (let i = 1; i <= 7; i++) {
					const meta = await store.create(home, "fake/model", `会话 ${i}`);
					await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "内容" }], timestamp: Date.now() + i } });
				}
				await store.append(archived, { type: "message", message: { role: "user", content: [{ type: "text", text: "内容" }], timestamp: 1 } });
				await store.setArchived(archived.id, true);
			} finally { store.close(); }
			await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [], appearance: { theme: "light" },
				projects: [{ id: projectId, name: PROJECT, path: home, lastOpenedAt: 1 }] }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 800 }));
		},
	});
	const recording: Frame[] = [];
	const cdp = await frameGrabber(9895);
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	let stopRecording: (() => Promise<void>) | undefined;
	let passed = 0;
	function check(label: string, ok: boolean, detail: unknown) {
		console.log(`${ok ? "✅" : "❌"} ${label}：${JSON.stringify(detail)}`);
		assert.ok(ok, label);
		passed++;
	}
	async function played(name: string, selector: string) {
		await hover(app, "main");
		await frames(app, 40);
		const resting = (await sample(app, selector, 50))[0]!.state;
		await hover(app, selector);
		const moving = await sample(app, selector);
		check(`${name}悬停有连续帧变化`, new Set(moving.map((s) => s.state)).size > 2, { positions: new Set(moving.map((s) => s.state)).size });
		check(`${name}动画不挪动按钮和图标位置`, new Set(moving.map((s) => s.box)).size === 1, moving[0]!.box);
		await shot(app, `${STAMP}_悬停_${name}`);
		await hover(app, "main");
		await until(app, near(state(selector), resting));
		check(`${name}移出回到原样`, true, "与悬停前一致");
		return resting;
	}
	try {
		if (directory) stopRecording = await startRecording(9895, recording);
		await until(app, `!!document.querySelector('${FOLDER}')`);
		await hover(app, "main");
		await frames(app, 60);
		await shot(app, `${STAMP}_01_静止`);
		const resting: Record<string, string> = {};
		for (const [name, selector] of TARGETS) resting[name] = await played(name, selector);

		await app.evaluate(`document.documentElement.dataset.reduceMotion='on'`);
		const moved: string[] = [];
		for (const [name, selector] of TARGETS) {
			await hover(app, selector);
			if (!(await sample(app, selector, 400)).every((s) => samePose(s.state, resting[name]!))) moved.push(name);
			await hover(app, "main");
		}
		check("开启减少动态效果时都不动", moved.length === 0, { checked: TARGETS.length, moved });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='off'`);

		await click(app, MORE);
		await until(app, `[...document.querySelectorAll('[data-ly-row]')].some(r=>r.innerText.includes('会话 1'))`);
		check("点「显示更多」仍会展开", true, "会话 1 可见");
		await played("收起", MORE);

		await click(app, FOLDER);
		await until(app, `document.querySelector('${FOLDER}').getAttribute('aria-expanded')==='false'`);
		await played("收起的项目文件夹", FOLDER);
		await click(app, FOLDER);
		await until(app, `document.querySelector('${FOLDER}').getAttribute('aria-expanded')==='true'`);

		const archived = await app.evaluate<string>(`document.querySelector('${ARCHIVE}').getAttribute('aria-label')`);
		await click(app, ARCHIVE);
		await until(app, `!document.querySelector('button[aria-label="${archived}"]')`);
		check("点归档仍会把会话移出列表", true, archived);

		await click(app, '[data-ly-rail-item="settings"]');
		await click(app, "button", "已归档的聊天");
		const remove = 'button[aria-label="删除「已归档会话」"]';
		// 已归档页按项目分组，组默认收着，行里的按钮点不到。
		await click(app, "[data-ly-archive-toggle]");
		await until(app, `document.querySelector('[data-ly-archive-toggle]').getAttribute('aria-expanded')==='true'`);
		await until(app, `!!document.querySelector('${remove}')`);
		await frames(app, 30);
		await played("已归档页删除", remove);
	} finally {
		await stopRecording?.();
		cdp.close();
		await app.stop();
		if (directory && recording.length > 1) await encode(recording, join(directory, `${STAMP}_会话列表图标_${passed}of30.mp4`), 30);
	}
});
