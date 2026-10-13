/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 模型弹窗里找模型：左边按厂商筛、上面打字、方向键加回车选——在真窗口里边验边录。
 *
 * 单测（`test/ui/model-rail.test.ts`）在 happy-dom 里验过筛选和按键的规矩；这里补它证不到的：
 * 侧栏和列表并排时卡片多宽多高、筛选时搜索框和侧栏会不会在指针下挪位置、指针和方向键是不是只亮一行。
 *
 * 用法：pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/model-rail-demo.ts [输出目录]
 * 主进程用 `out/` 里构建好的，渲染进程走开发服务器，所以只改了渲染进程时不用重新构建。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, frames, MODEL_MENU, openModelMenu, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume模型选择弹窗测试");
const PORT = 9471;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** 三家供应商、几家厂商，外加两个认不出厂商的——侧栏要有东西可选，列表要长到得滚。 */
const PROVIDERS = [
	{ id: "cliproxy", name: "cliproxyapi", models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-luna", "codex-auto-review", "claude-opus-5", "claude-sonnet-5"] },
	{ id: "opencode", name: "OpenCode Go", models: ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3", "qwen-4-max", "glm-5.3-flash", "minimax-m3"] },
	{ id: "relay", name: "Relay", models: ["claude-haiku-5", "gemini-3.7-pro", "gemini-3.7-flash", "grok-4.6-fast", "my-finetune"] },
];

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			appearance: { reduceMotion: "off" },
			providers: PROVIDERS.map((provider) => ({
				id: provider.id,
				name: provider.name,
				baseUrl: "http://127.0.0.1:9",
				api: "openai-responses",
				apiKey: "not-a-key",
				enabled: true,
				models: provider.models.map((name, i) => ({
					id: `${provider.id}/${name}`,
					providerId: provider.id,
					modelId: name,
					name,
					contextWindow: i % 3 === 0 ? 1_000_000 : 200_000,
					maxOutputTokens: 8192,
					supportsThinking: true,
					supportsImages: true,
					supportsTools: true,
				})),
			})),
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "opencode/deepseek-v4-flash",
			favoriteModelIds: ["opencode/deepseek-v4-flash", "cliproxy/claude-opus-5"],
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
		}),
	);
}

async function snap(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 卡片、搜索框、侧栏第一颗按钮的位置——筛选前后比一比，看有没有在指针下挪动。 */
const geometry = () =>
	app.evaluate<{ width: number; height: number; top: number; search: number; rail: number }>(`(()=>{
		const m=document.querySelector(${JSON.stringify(MODEL_MENU)}),r=m.getBoundingClientRect();
		const rail=m.querySelector('nav button')?.getBoundingClientRect();
		return {width:Math.round(r.width),height:Math.round(r.height),top:Math.round(r.top),search:Math.round(m.querySelector('input').getBoundingClientRect().top),rail:Math.round(rail?.top??-1)};
	})()`);
const rows = () => app.evaluate<string[]>(`[...document.querySelectorAll('${MODEL_MENU} [data-model]')].map(e=>e.dataset.model)`);
/** 真的「亮着」的行：按算出来的底色数，不按属性数——要验的正是 CSS 有没有把 hover 那行压下去。 */
const lit = () =>
	app.evaluate<string[]>(`[...document.querySelectorAll('${MODEL_MENU} [data-model]')].filter(e=>{const b=getComputedStyle(e).backgroundColor;return b!=='rgba(0, 0, 0, 0)'&&b!=='transparent'}).map(e=>e.dataset.model)`);

await mkdir(OUT_DIR, { recursive: true });
const renderer = await startDevRenderer();
app = await startApp({ port: PORT, seed, rendererUrl: renderer.url });
const frameList: Frame[] = [];
let stop: (() => Promise<void>) | undefined;
try {
	await until(app, `document.querySelector('main button[aria-haspopup="menu"][aria-label="选择模型"]')`);
	stop = await startRecording(PORT, frameList);
	await pause(800);

	console.log("1. 打开弹窗");
	await openModelMenu(app);
	await pause(900);
	await snap("01_打开");
	const opened = await geometry();
	const labels = await app.evaluate<string[]>(`[...document.querySelectorAll('${MODEL_MENU} nav button')].map(e=>e.getAttribute('aria-label'))`);
	const expected = ["全部模型", "收藏", "OpenAI", "Claude", "DeepSeek", "Kimi", "Qwen", "MiniMax", "Gemini", "Grok", "其他"];
	check("侧栏：全部、收藏，再按出现顺序排各家，认不出的放最后", JSON.stringify(labels) === JSON.stringify(expected), labels);
	// 卡片要在模型按钮上方，不能平移过去盖住它。
	const trigger = await app.evaluate<number>(`Math.round(document.querySelector('main button[aria-haspopup="menu"][aria-label="选择模型"]').getBoundingClientRect().top)`);
	check(`卡片 380×420，在模型按钮上方（${opened.width}×${opened.height}）`, opened.width === 380 && opened.height === 420 && opened.top + opened.height <= trigger, { opened, trigger });
	const railFits = await app.evaluate<boolean>(`(()=>{const n=document.querySelector('${MODEL_MENU} nav');return n.scrollHeight<=n.clientHeight})()`);
	check("侧栏十一颗按钮全放得下，不用滚", railFits, railFits);
	const footer = await app.evaluate<string>(`document.querySelector(${JSON.stringify(MODEL_MENU)}).textContent`);
	check("底下不再有「关闭思考」和「管理供应商与模型」", !/关闭思考|管理供应商与模型/.test(footer), footer);

	console.log("2. 点侧栏的 DeepSeek");
	await click(app, `${MODEL_MENU} nav button[aria-label="DeepSeek"]`);
	await frames(app, 10);
	await pause(1000);
	await snap("02_只看DeepSeek");
	const deepseek = await rows();
	check("只剩 DeepSeek 的两个", JSON.stringify(deepseek) === JSON.stringify(["opencode/deepseek-v4-flash", "opencode/deepseek-v4-pro"]), deepseek);
	const menuText = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(MODEL_MENU)}).textContent`);
	const statusRow = await menuText();
	check("列表底下不再挂设默认模型的那一行", !statusRow.includes("默认模型"), statusRow);
	const narrowed = await geometry();
	check("列表变短了，搜索框和侧栏没挪位置", narrowed.search === opened.search && narrowed.rail === opened.rail && narrowed.height === opened.height, { opened, narrowed });

	console.log("3. 点收藏，再点全部");
	await click(app, `${MODEL_MENU} nav button[aria-label="收藏"]`);
	await frames(app, 10);
	await pause(900);
	const starred = await rows();
	check("收藏只列星标的，按标星的先后", JSON.stringify(starred) === JSON.stringify(["opencode/deepseek-v4-flash", "cliproxy/claude-opus-5"]), starred);
	await click(app, `${MODEL_MENU} nav button[aria-label="全部模型"]`);
	await frames(app, 10);
	await pause(700);
	const focused = await app.evaluate<boolean>(`document.activeElement===document.querySelector('${MODEL_MENU} input')`);
	check("点过侧栏，焦点还在搜索框里", focused, focused);

	console.log("4. 打字筛，方向键挪，回车选");
	await type(app, `${MODEL_MENU} input`, "gemini");
	await pause(900);
	await snap("03_搜索gemini");
	const searched = await rows();
	check("打 gemini 剩两个", searched.length === 2 && searched.every((id) => id.includes("gemini")), searched);
	check("高亮落在第一个匹配上", JSON.stringify(await lit()) === JSON.stringify([searched[0]]), await lit());
	await press(app, "ArrowDown", 40);
	await pause(800);
	await snap("04_方向键下移");
	check("↓ 之后亮的是第二个，而且只亮一行", JSON.stringify(await lit()) === JSON.stringify([searched[1]]), await lit());
	await press(app, "Enter", 13);
	await until(app, `!document.querySelector(${JSON.stringify(MODEL_MENU)})`);
	await pause(900);
	const chip = await app.evaluate<string>(`document.querySelector('main button[aria-haspopup="menu"][aria-label="选择模型"]').textContent`);
	check(`回车选中、弹窗关掉，输入框那行换成了它（${chip}）`, chip.includes("gemini-3.7-flash"), chip);
	await snap("05_回车选中");

	console.log("5. 指针和方向键共用一个高亮");
	await openModelMenu(app);
	await pause(600);
	const target = `${MODEL_MENU} [data-model="cliproxy/gpt-6-luna"]`;
	const box = await app.evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {x:r.left+60,y:r.top+r.height/2}})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
	await frames(app, 10);
	await pause(800);
	const hovered = await lit();
	check("指针停在 gpt-6-luna 上，亮的是它（加上选中那行的色块）", hovered.includes("cliproxy/gpt-6-luna"), hovered);
	await press(app, "ArrowDown", 40);
	await pause(800);
	await snap("06_指针不动按方向键");
	const moved = (await lit()).filter((id) => id !== "relay/gemini-3.7-flash");
	check("指针没动、按了 ↓：亮的换成下一行，指针下那行熄掉", JSON.stringify(moved) === JSON.stringify(["cliproxy/codex-auto-review"]), moved);
	// 再往下按到列表得滚：滚动时指针下换了一行，Chromium 会补发一次没有位移的 mousemove，高亮不能被它抢走。
	const order = await rows();
	const start = order.indexOf("cliproxy/codex-auto-review");
	for (let i = 0; i < 8; i++) await press(app, "ArrowDown", 40);
	await pause(800);
	await snap("07_方向键滚动列表");
	const scrolled = (await lit()).filter((id) => id !== "relay/gemini-3.7-flash");
	check(`连按 8 次 ↓、列表滚动后，亮的是 ${order[start + 8]}，不是指针下那行`, JSON.stringify(scrolled) === JSON.stringify([order[start + 8]]), scrolled);
	await press(app, "Escape", 27);
	await pause(800);

} finally {
	await stop?.();
	await app.stop();
	await renderer.close();
}

const passed = checks.filter((each) => each.ok).length;
const video = join(OUT_DIR, `${STAMP}_模型弹窗侧栏筛选与键盘选择_${passed}of${checks.length}.mp4`);
await encode(frameList, video, 30);
console.log(`\n${passed}/${checks.length} 通过 → ${video}`);
process.exit(passed === checks.length ? 0 : 1);
