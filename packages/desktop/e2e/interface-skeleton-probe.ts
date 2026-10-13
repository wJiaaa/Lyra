/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 界面块边写边出的点阵骨架——在真窗口里逐帧量。
 *
 * 假模型把一段界面块按真模型的节奏流出来，页面里一个 rAF 采样器每帧记下：正在写的标签有没有占位、
 * 占位挂在哪、刚到的元素有没有在淡入、块的高度、转录离底部多远。量的是：
 * - 写到一半的 Chart 先有一块施工占位，挂在它将来的父元素（Card）里：四角有手柄，点阵从中心涟漪
 *   展开（画布上亮着的像素越来越多），之后一直在动；
 * - 标签写完，图表先藏起来、按自己的结构描出点状线框，再自上而下揭开：擦除边只往下走，扫描线贴着它；
 * - 写完以后没有占位、没有残留的点阵层、没有还在跑的动画；
 * - 骨架没有让块的高度一帧跳一大截，也没有把转录推离底部更多；
 * - 重开会话时直接画，不出骨架、不放动画；
 * - 「减少动态效果」开着时，占位照样有但不动，到达不放动画；写完之前整块照样不能点（从前这时
 *   `writing` 不亮，选项还在长就点得动）。
 *
 * 同一条剧本改前改后各跑一次（LABEL=before / after），两份输出对照。
 * 用法：LABEL=after node --experimental-strip-types e2e/interface-skeleton-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume界面块骨架屏测试");
const LABEL = process.env.LABEL ?? "after";
const PORT = 9861;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "interface-skeleton";
const BLOCK = "main [data-ly-interface]";

const REPLY = `按你说的跑了一遍：

\`\`\`ui
<Card title="本周">
  <Grid cols={3}>
    <Stat label="会话" value="3,281"/>
    <Stat label="平均轮数" value="9.4"/>
    <Stat label="缓存命中" value="87%"/>
  </Grid>
  <Chart kind="bar" data={[{d:"一",v:32},{d:"二",v:48},{d:"三",v:41},{d:"四",v:66},{d:"五",v:58},{d:"六",v:81},{d:"日",v:74}]} x="d"/>
  <Table columns={["文件","改动行"]} rows={[["parse.ts","+18 −3"],["InterfaceBlock.tsx","+42 −6"],["interface.css","+27"]]}/>
  <Row>
    <Button send="就按这个改" primary>就按这个改</Button>
    <Button send="再看看">再看看</Button>
  </Row>
</Card>
\`\`\`

就这些。`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function stream(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	// 和 interface-block-demo 同一个节奏：每段 14 个字、隔 90ms。
	for (let at = 0; at < text.length; at += 14) {
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(at, at + 14) } });
		await wait(90);
	}
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			void stream(res, REPLY);
		});
	});
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "骨架", cwd, projectId, projectName: "界面块", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "看看本周的数" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: process.env.THEME === "dark" ? "dark" : "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "界面块", pinned: true, lastOpenedAt: 1 }],
	}));
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from(image.data, "base64"));
};
async function say(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);

interface Sample {
	t: number;
	state: string;
	pending: string[];
	/** 占位的父元素是不是 Card 的 section。 */
	inCard: boolean;
	charts: number;
	/** 块里由脚本放的动画（不算骨架自己的 CSS 脉动）。 */
	scripted: number;
	fades: number;
	/** 占位画布上有颜色的像素数和画面签名：每 4 帧量一次，其余帧是 -1。 */
	coverage: number;
	sig: number;
	handles: number;
	/** 第一个占位是哪一个：同名的占位（三个 Stat）各是各的画布。 */
	pid: number;
	/** 正在描线揭开的层：有几层，最后一层画出了几条线，被擦到哪（百分比），扫描线离擦除边差几像素。 */
	traces: number;
	wires: number;
	wiped: number;
	gap: number;
	/** 图表那个元素自己的内联不透明度：描线的时候是 0，揭开以后还原成空。 */
	chartOpacity: string;
	inert: boolean;
	height: number;
	follow: number;
}

/** 每一绘制帧记一条，直到停下。量的是最后一个界面块。 */
const startSampler = (app: RunningApp) => app.evaluate(`(() => {
	window.__samples = [];
	window.__sampling = true;
	window.__n = 0;
	window.__ids = window.__ids ?? new Map();
	const start = performance.now();
	const tick = () => {
		if (!window.__sampling) return;
		const block = [...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1);
		const scroller = [...document.querySelectorAll("main .ly-scroll-view")].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
		if (block) {
			const pending = [...block.querySelectorAll(".ly-ui-pending")];
			const grow = block.closest(".my-2\\\\.5") ?? block;
			window.__samples.push({
				t: Math.round(performance.now() - start),
				state: block.dataset.lyInterface,
				pending: pending.map((el) => el.dataset.lyUiPending),
				inCard: pending.some((el) => el.parentElement?.tagName === "SECTION"),
				charts: block.querySelectorAll(".ly-ui-chart").length,
				scripted: block.parentElement.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).length,
				fades: block.parentElement.querySelectorAll(".ly-ui-fade").length,
				...(() => {
					const canvas = pending[0]?.querySelector("canvas");
					if (!canvas || window.__n++ % 4) return { coverage: -1, sig: -1 };
					const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
					let coverage = 0, sig = 0;
					for (let i = 3; i < data.length; i += 4) if (data[i]) { coverage++; sig = (sig * 31 + data[i] + i) % 1000000007; }
					return { coverage, sig };
				})(),
				handles: pending[0] ? pending[0].querySelectorAll(".ly-ui-handle").length : 0,
				pid: pending[0] ? (window.__ids.get(pending[0]) ?? (window.__ids.set(pending[0], window.__ids.size + 1), window.__ids.size)) : 0,
				...(() => {
					const traces = [...block.parentElement.querySelectorAll(".ly-ui-trace")];
					// 图表自己的那一层：表格的层可能同时在画。描线层和到达的元素一样大，从图表往上找那个元素。
					const same = (a, b) => Math.abs(a.top - b.top) < 2 && Math.abs(a.height - b.height) < 2;
					let trace;
					for (let at = block.querySelector(".ly-ui-chart"); at && at !== block && !trace; at = at.parentElement) {
						trace = traces.find((layer) => same(layer.getBoundingClientRect(), at.getBoundingClientRect()));
					}
					if (!trace) return { traces: 0, wires: 0, wiped: -1, gap: -1 };
					const box = trace.getBoundingClientRect();
					const top = parseFloat(trace.style.clipPath.replace("inset(", "")) || 0;
					const scan = trace.querySelector(".ly-ui-scan");
					return {
						traces: traces.length,
						wires: [...trace.querySelectorAll(".ly-ui-wire")].filter((path) => path.style.opacity === "1").length,
						wiped: (top / box.height) * 100,
						gap: scan && scan.style.opacity === "1" ? Math.round(Math.abs(scan.getBoundingClientRect().top - (box.top + top))) : -1,
					};
				})(),
				chartOpacity: (() => {
					const chart = block.querySelector(".ly-ui-chart");
					// 到达时被藏起来的就是图表那个元素本身或它的某一层外壳
					for (let at = chart; at && at !== block; at = at.parentElement) if (at.style.opacity) return at.style.opacity;
					return chart ? "" : "none";
				})(),
				inert: block.inert,
				height: Math.round(grow.getBoundingClientRect().height),
				follow: scroller ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : -1,
			});
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`);
const stopSampler = (app: RunningApp) => app.evaluate<Sample[]>(`(() => { window.__sampling = false; return window.__samples; })()`);
const maxStep = (values: number[]) => values.reduce((most, value, i) => (i ? Math.max(most, Math.abs(value - values[i - 1]!)) : 0), 0);

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-interface-skeleton-"));
await seed(home, modelAddress.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);

	console.log(`\n[${LABEL}] 一、写的时候：正在写的标签先有点阵占位`);
	await startSampler(app);
	await say(app, "UI 看看本周");
	// 统计已经出来、图还在写：两次跑都在这一刻拍，改前这里是空的。
	await until(app, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1); return b && b.querySelectorAll(".text-heading.tabular-nums").length === 3 && !b.querySelector(".ly-ui-chart"); })()`, 1200);
	await pause(250);
	await shot(app, "01_图表还在写");
	await until(app, `[...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1)?.querySelector(".ly-ui-chart")`, 1200);
	await shot(app, "02_图表正在揭开");
	await idle(app);
	await pause(1200);
	const live = (await stopSampler(app)).filter((s) => s.state);
	const writing = live.filter((s) => s.state === "writing");
	const chartPending = writing.filter((s) => s.pending.includes("Chart") && s.charts === 0);
	check("图表写到一半时，它的位置上有一块点阵占位", chartPending.length > 3, `${chartPending.length} 帧`);
	check("占位挂在它将来的父元素（Card）里", chartPending.length > 0 && chartPending.every((s) => s.inCard), chartPending.slice(0, 1));
	check("图表还在写的时候没有别的元素在描线（容器不描线）", chartPending.every((s) => s.traces === 0), [...new Set(chartPending.map((s) => s.traces))]);
	check("占位四个角都有手柄", chartPending.every((s) => s.handles === 4), [...new Set(chartPending.map((s) => s.handles))]);
	const cover = chartPending.map((s) => s.coverage).filter((c) => c >= 0);
	check("点阵从中心涟漪展开：画布上有颜色的像素越来越多", cover.length > 3 && cover[0]! < cover.at(-1)! * 0.6 && cover.every((c, i) => i === 0 || c >= cover[i - 1]! * 0.97), cover);
	const sigs = new Set(chartPending.map((s) => s.sig).filter((g) => g >= 0));
	check("占位一直在动：每次量画面都不一样", sigs.size === cover.length, { measured: cover.length, distinct: sigs.size });
	const arrival = live.findIndex((s) => s.charts > 0);
	const after = live.slice(arrival, arrival + 200);
	const mostWires = Math.max(...after.map((s) => s.wires));
	check("图表一到先藏起来，按自己的结构描线框", after[0]?.chartOpacity === "0" && mostWires >= 3, { first: after[0]?.chartOpacity, wires: mostWires });
	const wipe = after.map((s) => s.wiped).filter((w) => w >= 0);
	check("揭开自上而下：擦除边只往下走，从顶到底", wipe.length > 5 && wipe[0]! < 5 && wipe.every((v, i) => i === 0 || v >= wipe[i - 1]! - 0.5) && wipe.at(-1)! > 80, wipe.filter((v, i) => i % 4 === 0).map(Math.round));
	const gaps = live.map((s) => s.gap).filter((g) => g >= 0);
	check("扫描线贴着擦除边走（差不超过 2px）", gaps.length > 5 && Math.max(...gaps) <= 2, { frames: gaps.length, most: Math.max(...gaps) });
	check("同一帧里不会既有图表又有图表的占位", live.every((s) => !(s.charts > 0 && s.pending.includes("Chart"))), live.filter((s) => s.charts > 0 && s.pending.includes("Chart")).length);
	const end = live.at(-1);
	check("写完以后：没有占位、没有残留的点阵层和线框、没有在跑的动画，图表还原", end?.state === "ready" && end.pending.length === 0 && end.fades === 0 && end.traces === 0 && end.scripted === 0 && end.chartOpacity === "", end);
	const heightStep = maxStep(writing.map((s) => s.height));
	const deepest = Math.max(...live.map((s) => s.follow));
	console.log(`      块高度单帧最大变化 ${heightStep}px；转录离底部最深 ${deepest}px；写了 ${writing.length} 帧`);
	check("块的高度一帧不跳超过 40px", heightStep <= 40, heightStep);
	await shot(app, "03_写完");

	console.log(`\n[${LABEL}] 二、重开会话：直接画，不出骨架、不放动画`);
	await app.evaluate("location.reload()");
	await until(app, `document.querySelector('[data-ly-row="${SESSION}"]')`, 1200);
	await startSampler(app);
	await openSession(app, SESSION);
	await until(app, `document.querySelector(${JSON.stringify(BLOCK)})`, 1200);
	await pause(1000);
	const reopened = (await stopSampler(app)).filter((s) => s.state);
	check("重开以后一帧占位也没有，也没有到达动画", reopened.length > 0 && reopened.every((s) => s.pending.length === 0 && s.scripted === 0 && s.fades === 0 && s.traces === 0), { frames: reopened.length, last: reopened.at(-1) });

	console.log(`\n[${LABEL}] 三、减少动态效果：占位不动，到达不放动画，写完之前照样不能点`);
	await app.evaluate(`document.documentElement.dataset.reduceMotion = "on"`);
	await startSampler(app);
	await say(app, "UI 再来一次");
	await until(app, `[...document.querySelectorAll(${JSON.stringify(BLOCK)})].length >= 2`, 1200);
	await idle(app);
	await pause(800);
	const still = (await stopSampler(app)).filter((s) => s.state);
	const stillWriting = still.filter((s) => s.state === "writing");
	check("写完之前整块不能点（writing、inert）", stillWriting.length > 10 && stillWriting.every((s) => s.inert), { writing: stillWriting.length, notInert: stillWriting.filter((s) => !s.inert).length });
	const stillPending = still.filter((s) => s.pending.length);
	const ids = [...new Set(stillPending.map((s) => s.pid))];
	const kinds = ids.map((id) => new Set(stillPending.filter((s) => s.pid === id && s.sig >= 0).map((s) => s.sig)).size);
	check("占位照样出现，但是静止的：同一个占位每次量画面都一样", stillPending.length > 0 && kinds.every((n) => n <= 1), { frames: stillPending.length, placeholders: ids.length, kinds });
	check("到达时不描线、没有点阵层、没有脚本动画", still.every((s) => s.scripted === 0 && s.fades === 0 && s.traces === 0), still.filter((s) => s.scripted || s.fades || s.traces).length);
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_${LABEL}_界面块骨架_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
