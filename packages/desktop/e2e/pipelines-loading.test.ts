import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";
import { seedInteractions } from "./interaction-fixture.ts";

let app: RunningApp;
let forge: Server;
let baseUrl: string;
let project: string;
let hold = false;
let hasRun = false;
let requests = 0;
const pending = new Set<ServerResponse>();
const artifacts = process.env.PLUME_E2E_ARTIFACTS;
const pane = '[data-dock-pane="review"]';
const view = `${pane} [data-view="pipelines"]`;
const tab = (label: string) => `[...document.querySelectorAll('${pane} button')].find(e=>(e.dataset.lyTip||'').startsWith(${JSON.stringify(label)})||e.querySelector('span')?.textContent===${JSON.stringify(label)})`;

function answer(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ workflow_runs: hasRun ? [{ id: 101, name: "Synthetic pipeline", display_title: "Synthetic cached run", event: "push", status: "completed", conclusion: "success", head_branch: "main", head_sha: "abcdef0123456789", created_at: "2026-09-07T00:00:00Z", html_url: `${baseUrl}/fixture/repo/actions/runs/101` }] : [] }));
}

function release(withRun = hasRun): void {
	hasRun = withRun;
	hold = false;
	for (const res of pending) answer(res);
	pending.clear();
}

before(async () => {
	// Synthetic Forge responses enter through real Git remotes, account storage and Electron IPC.
	forge = createServer((req, res) => {
		req.resume();
		if (!req.url?.startsWith("/api/v3/repos/fixture/repo/actions/runs?")) {
			res.writeHead(404); res.end(); return;
		}
		requests++;
		if (!hold) { answer(res); return; }
		pending.add(res);
		res.once("close", () => pending.delete(res));
	});
	await new Promise<void>((resolve) => forge.listen(0, "127.0.0.1", resolve));
	const address = forge.address();
	assert.ok(address && typeof address !== "string");
	baseUrl = `http://127.0.0.1:${address.port}`;
	app = await startApp({ port: 9652, seed: async (home) => {
		await seedInteractions(home);
		project = join(home, "project");
		await promisify(execFile)("git", ["remote", "add", "origin", `${baseUrl}/fixture/repo.git`], { cwd: project });
		await writeFile(join(home, "forges.json"), JSON.stringify({ version: 1, entries: [{ account: { id: "synthetic-forge", kind: "github", baseUrl, login: "synthetic", label: "Synthetic local Forge", avatarUrl: null, addedAt: 1, enabled: true }, token: "synthetic-test-token", encrypted: false }] }));
	} });
	await until(`document.querySelector('[data-ly-row="qa-short"] > button')`);
	await click(`document.querySelector('[data-ly-row="qa-short"] > button')`);
	if (artifacts) await mkdir(artifacts, { recursive: true });
});

after(async () => {
	await cleanupFixture(
		() => app?.stop(),
		() => { for (const res of pending) res.destroy(); },
		() => closeListeningServer(forge),
	);
});

async function frames(count = 12): Promise<void> {
	await app.evaluate(`new Promise(resolve=>{let n=0;function tick(){if(++n>=${count})resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)})`);
}

async function until(expression: string): Promise<void> {
	await app.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+10000;function tick(){if(${expression})resolve();else if(performance.now()>end)reject(Error('UI condition timed out: '+${JSON.stringify(expression)}+'; '+document.body.innerText.slice(-1600)));else requestAnimationFrame(tick)}tick()})`);
}

async function click(expression: string): Promise<void> {
	await until(expression);
	// Pane layout changes can move this toolbar; separate CDP messages must not press stale coordinates.
	const point = await app.evaluate<{ x: number; y: number }>(`(async()=>{
		const end=performance.now()+10000;let previous='',last;
		while(performance.now()<end){
			const e=${expression},r=e?.getBoundingClientRect();
			if(e&&r){
				const x=r.left+r.width/2,y=r.top+r.height/2;
				let ready=e.isConnected&&!e.matches(':disabled')&&e.checkVisibility({visibilityProperty:true,opacityProperty:true})&&r.width>0&&r.height>0&&e.contains(document.elementFromPoint(x,y));
				for(let ancestor=e;ancestor;ancestor=ancestor.parentElement){
					ready&&=!ancestor.getAnimations().some(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)&&(a.pending||a.playState==='running'));
				}
				const box=JSON.stringify([r.x,r.y,r.width,r.height]);
				last={box,ready,hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,300)};
				if(ready&&box===previous)return {x,y};
				previous=ready?box:'';
			}
			await new Promise(requestAnimationFrame);
		}
		throw Error('Click target did not become visible and stable: '+${JSON.stringify(expression)}+'; '+JSON.stringify(last));
	})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
}

async function openGit(): Promise<void> {
	await click(`document.querySelector('button[aria-label="面板"]')`);
	await click(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim().startsWith('Git'))`);
	await until(tab("流水线"));
	await frames();
}

async function closeGit(): Promise<void> {
	if (!await app.evaluate(`Boolean(document.querySelector('${pane}'))`)) return;
	await click(`document.querySelector('[data-dock-header="review"] button[aria-label^="关闭"]')`);
	await until(`!document.querySelector('${pane}')`);
}

interface Frame {
	t: number;
	visible: boolean;
	text: string;
	header: boolean;
	empty: boolean;
	row: boolean;
	loading: boolean;
	pending: boolean;
	actions: boolean;
	width: number;
	overflow: number;
}

async function startTrace(): Promise<void> {
	// Only visible DOM and geometry are sampled; React internals cannot prove what was painted.
	await app.evaluate(`(()=>{const trace={frames:[],active:true,pending:true,start:performance.now()};window.__pipelineTrace=trace;function tick(){const e=document.querySelector('${view}'),r=e?.getBoundingClientRect(),visible=!!e&&e.checkVisibility()&&r.width>0&&r.height>0,text=visible?e.innerText:'';trace.frames.push({t:performance.now()-trace.start,visible,text,header:text.includes('CI / CD 流水线'),empty:/暂无(?:流水线)?运行记录/.test(text),row:text.includes('Synthetic cached run'),loading:visible&&!!e.querySelector('[aria-busy="true"],.ly-skeleton'),pending:trace.pending,actions:visible&&!!e.querySelector('button[aria-label="刷新流水线"]'),width:r?.width??0,overflow:visible?e.scrollWidth-e.clientWidth:0});if(trace.active)requestAnimationFrame(tick)}requestAnimationFrame(tick)})()`);
}

async function screenshot(name: string): Promise<void> {
	if (!artifacts) return;
	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(artifacts, `${name}.png`), Buffer.from(shot.data, "base64"));
}

async function capture(name: string, enter: () => Promise<void>, withRun: boolean): Promise<Frame[]> {
	hold = true;
	const previousRequests = requests;
	await startTrace();
	await enter();
	await frames(2);
	await screenshot(`${name}-pending`);
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (requests > previousRequests) break;
		await frames(2);
	}
	assert.ok(requests > previousRequests, `${name}: a real Forge request starts`);
	await frames(18);
	await app.evaluate(`window.__pipelineTrace.pending=false`);
	release(withRun);
	await until(`document.querySelector('${view}')?.innerText.includes(${JSON.stringify(withRun ? "Synthetic cached run" : "运行记录")})`);
	await frames();
	await screenshot(`${name}-settled`);
	const result = await app.evaluate<Frame[]>(`(()=>{window.__pipelineTrace.active=false;return window.__pipelineTrace.frames})()`);
	if (artifacts) await writeFile(join(artifacts, `${name}.json`), JSON.stringify({ source: "Synthetic local HTTP Forge responses; real Electron application, native clicks, normal IPC and visible DOM frames", frames: result }, null, 2));
	return result.filter((frame) => frame.visible);
}

test("pipeline loading and retained refresh never flash an unrelated list or lose cached content", { timeout: 180000 }, async (t) => {
	const failures: string[] = [];
	for (const theme of ["light", "dark"]) for (const width of [1200, 375]) {
		const name = `${theme}-${width}`;
		t.diagnostic(`${name}: cold loading, Activity return, empty remount and cached refresh`);
		await closeGit();
		await app.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
		await app.evaluate(`(async()=>{const s=await window.plume.settings.get();await window.plume.settings.save({...s,appearance:{...s.appearance,theme:${JSON.stringify(theme)}}});localStorage.removeItem(${JSON.stringify(`plume.pipelines.runs.v1:${project}`)})})()`);
		await until(`document.documentElement.classList.contains(${JSON.stringify(theme)})&&innerWidth===${width}`);
		hasRun = false;
		await openGit();
		const cold = await capture(`${name}-cold`, () => click(tab("流水线")), false);
		await click(tab("改动")); await frames();
		const retained = await capture(`${name}-activity-empty`, () => click(tab("流水线")), false);
		await closeGit(); await openGit();
		const remount = await capture(`${name}-remount-empty`, () => click(tab("流水线")), false);
		// A genuine response writes the populated cache before testing a retained refresh.
		hasRun = true;
		await click(tab("改动")); await frames();
		await click(tab("流水线"));
		await until(`document.querySelector('${view}')?.innerText.includes('Synthetic cached run')`);
		await frames();
		await click(tab("改动")); await frames();
		const cached = await capture(`${name}-activity-cached`, () => click(tab("流水线")), true);
		for (const [scenario, samples] of [["cold", cold], ["activity-empty", retained], ["remount-empty", remount], ["activity-cached", cached]] as const) {
			const headerFrames = samples.filter((frame) => frame.header && !frame.row);
			const emptyFrames = samples.filter((frame) => frame.empty);
			t.diagnostic(JSON.stringify({ name, scenario, frames: samples.length, headerFrames: headerFrames.length, firstHeaderMs: headerFrames[0]?.t, lastHeaderMs: headerFrames.at(-1)?.t, emptyFrames: emptyFrames.length, firstEmptyMs: emptyFrames[0]?.t }));
			if (!samples.length) failures.push(`${name}/${scenario}: no visible frames`);
			if (headerFrames.length) failures.push(`${name}/${scenario}: ${headerFrames.length} list-header frames without runs`);
			if (scenario === "cold" && samples.some((frame) => frame.pending && (frame.empty || frame.actions || frame.row))) failures.push(`${name}/${scenario}: result content or actions appeared before the response`);
			if (scenario === "cold" && !samples.some((frame) => frame.pending && frame.loading)) failures.push(`${name}/${scenario}: the held request never showed its loading state`);
			if (samples.some((frame) => frame.overflow > 1)) failures.push(`${name}/${scenario}: horizontal overflow`);
			if ((scenario === "activity-empty" || scenario === "remount-empty") && samples.some((frame) => !frame.empty)) failures.push(`${name}/${scenario}: known empty result disappeared while refreshing`);
			if (scenario === "activity-cached" && samples.some((frame) => !frame.row)) failures.push(`${name}/${scenario}: cached row disappeared while refreshing`);
		}
		if (remount.at(-1)?.text.trim() !== "暂无运行记录") failures.push(`${name}: empty state should only show concise copy`);
	}
	assert.deepEqual(failures, [], failures.join("\n"));
});
