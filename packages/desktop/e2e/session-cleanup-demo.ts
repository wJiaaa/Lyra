/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 在侧边栏里删掉一个会话，它写在项目外的东西是不是跟着走了，别人还在用的那张图是不是还在。
 *
 * 两个会话共用一张图（按内容寻址，盘上只有一份），要删的那个另有一张只有它用的图、一份侧边聊天
 * 存档、一个预览目录、一个草稿目录。另外放三样启动时该被补扫掉的：会话已经不在的侧边聊天目录、
 * 原图已经不在的缩略图、目录已经不在的符号索引。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/session-cleanup-demo.ts`
 */

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { persistSessionImage, type SessionMeta } from "@plume/core";

import { startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume删会话清理测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9815;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};
const exists = (path: string) => access(path).then(() => true, () => false);

const home = await mkdtemp(join(tmpdir(), "ly-cleanup-demo-"));
// Parked images go under PLUME_HOME; the seed must write them where the app will look.
process.env.PLUME_HOME = home;
const root = join(import.meta.dirname, "..", "..", "..");
const cwd = join(home, "project");
const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
const shared = persistSessionImage((await readFile(join(root, "assets", "plume.png"))).toString("base64"), "image/png");
const unique = persistSessionImage((await readFile(join(root, "assets", "plume-portrait.png"))).toString("base64"), "image/png");
const digest = (name: string) => name.replace(/\.[^.]+$/, "");

function session(id: string, title: string, images: string[], updatedAt: number) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta: SessionMeta = { id, title, cwd, projectId, projectName: "清理", createdAt: 1, updatedAt, modelId: "qa/model", messageCount: 1, usage, seq: 1 };
	const content = [{ type: "text" as const, text: `${title}：看看这几张图` }, ...images.map((media) => ({ type: "image" as const, data: "", mimeType: "image/png", media }))];
	return { meta, records: [{ type: "meta" as const, meta }, { type: "message" as const, message: { role: "user" as const, content, timestamp: updatedAt } }] };
}

await mkdir(cwd, { recursive: true });
seedSessions(home, [session("doomed", "要删的会话", [unique, shared], 3), session("kept", "留下的会话", [shared], 2)]);
const doomedLeft = [join(home, "sidechats", "doomed"), join(home, "previews", "doomed"), join(home, "scratch", "doomed")];
for (const dir of doomedLeft) await mkdir(dir, { recursive: true });
await writeFile(join(home, "sidechats", "doomed", "default.json"), JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "侧边问一句" }], timestamp: 1 }] }));
await writeFile(join(home, "previews", "doomed", "index.html"), "<!doctype html>");
await writeFile(join(home, "scratch", "doomed", "sample.csv"), "a,b\n");
await mkdir(join(home, "sidechats", "kept"), { recursive: true });
await writeFile(join(home, "sidechats", "kept", "default.json"), JSON.stringify({ messages: [] }));
// Startup sweep: a side chat folder with no session, a thumbnail with no source, an index of a directory that is gone.
await mkdir(join(home, "sidechats", "ghost"), { recursive: true });
await mkdir(join(home, "session-media", "thumbs"), { recursive: true });
await writeFile(join(home, "session-media", "thumbs", `${"c".repeat(40)}.128.png`), "x");
await mkdir(join(home, "index"), { recursive: true });
await writeFile(join(home, "index", "0000000000000000.json"), JSON.stringify({ cwd: join(home, "gone-worktree"), builtAt: 1, fileCount: 0, symbols: [], skipped: 0 }));
await writeFile(join(home, "index", "1111111111111111.json"), JSON.stringify({ cwd, builtAt: 1, fileCount: 0, symbols: [], skipped: 0 }));
await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
await writeFile(join(home, "settings.json"), JSON.stringify({
	providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test", enabled: true,
		models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
	defaultModelId: "qa/model",
	permissionMode: "full",
	appearance: { theme: "dark", reduceMotion: "off" },
	projects: [{ id: projectId, path: cwd, name: "清理", pinned: true, lastOpenedAt: 1 }],
}));

const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
try {
	await mkdir(out, { recursive: true });
	const running = await startApp({ port: PORT, reuseHome: home });
	app = running;
	stopRecording = await startRecording(PORT, frames);
	await running.evaluate("document.fonts.ready");
	const until = async (expression: string, ms = 20_000) => {
		for (let i = 0; i < ms / 100; i++) {
			if (await running.evaluate(`Boolean(${expression})`)) return;
			await pause(100);
		}
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_失败现场.png`), Buffer.from(picture.data, "base64"));
		throw new Error(`UI condition not reached: ${expression}`);
	};
	const shot = async (name: string) => {
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	};
	const center = (selector: string) => running.evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	const press = async (at: { x: number; y: number }, button: "left" | "right" = "left") => {
		await running.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
		await pause(200);
		for (const type of ["mousePressed", "mouseReleased"]) await running.send("Input.dispatchMouseEvent", { type, ...at, button, clickCount: 1 });
	};
	const pressText = async (scope: string, text: string) => {
		await until(`[...document.querySelectorAll(${JSON.stringify(scope)})].some((e)=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(text)})`);
		await running.evaluate(`(()=>{document.querySelector('[data-qa-target]')?.removeAttribute('data-qa-target');[...document.querySelectorAll(${JSON.stringify(scope)})].find((e)=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(text)}).setAttribute('data-qa-target','');})()`);
		await running.evaluate(`document.querySelector('[data-qa-target]').scrollIntoView({block:'nearest',behavior:'instant'})`);
		await pause(200);
		await press(await center("[data-qa-target]"));
	};

	await until(`document.querySelector('[data-ly-row="doomed"]')`);
	// The startup sweep runs in the background right after launch.
	await pause(1500);
	check("启动补扫：没有会话的侧边聊天目录被删", !(await exists(join(home, "sidechats", "ghost"))), { ghost: await exists(join(home, "sidechats", "ghost")) });
	check("启动补扫：原图不在的缩略图被删", (await readdir(join(home, "session-media", "thumbs"))).length === 0, await readdir(join(home, "session-media", "thumbs")));
	check("启动补扫：目录不在的符号索引被删，目录还在的留下", JSON.stringify((await readdir(join(home, "index"))).sort()) === JSON.stringify(["1111111111111111.json"]), await readdir(join(home, "index")));
	check("还在的会话的侧边聊天没被补扫碰", await exists(join(home, "sidechats", "kept", "default.json")), {});

	await press(await center('[data-ly-row="doomed"]'));
	await until(`[...document.querySelectorAll('main img')].filter((img)=>img.checkVisibility()).length >= 2`);
	await pause(1200);
	await shot("01_删除前_要删的会话里两张图");
	const before = { media: (await readdir(join(home, "session-media"))).filter((name) => name.endsWith(".png")).sort(), left: await Promise.all(doomedLeft.map(exists)) };
	check("删除前：两张图、侧边聊天、预览、草稿都在", before.media.length === 2 && before.left.every(Boolean), before);

	// Only an archived session can be deleted: archive it from the sidebar, then delete it on the archive page.
	await press(await center('[data-ly-row="doomed"]'), "right");
	await pause(800);
	await pressText('[role="menuitem"]', "归档");
	await until(`!document.querySelector('[data-ly-row="doomed"]')`);
	await pause(800);
	await press(await center("button:has(svg.lucide-settings)"));
	await pressText("nav button", "已归档的聊天");
	await pause(800);
	await until(`document.querySelector('[aria-label^="清理，"]')`);
	await press(await center('[aria-label^="清理，"]'));
	await until(`document.querySelector('[aria-label="删除「要删的会话」"]')`);
	await pause(800);
	await press(await center('[aria-label="删除「要删的会话」"]'));
	await pause(800);
	await shot("02_确认删除");
	await pressText('[role="dialog"] button', "删除");
	await until(`!document.querySelector('[aria-label="删除「要删的会话」"]')`);
	await pause(1000);
	await shot("03_已从归档里删掉");
	await pressText("button", "返回工作区");
	await until(`document.querySelector('[data-ly-row="kept"]')?.checkVisibility()`);
	await pause(800);

	const media = (await readdir(join(home, "session-media"))).filter((name) => name.endsWith(".png"));
	check("只有它用的那张图跟着删了", !media.includes(unique), { unique: digest(unique).slice(0, 8), media: media.map((name) => digest(name).slice(0, 8)) });
	check("另一个会话还在用的那张留下", media.includes(shared), { shared: digest(shared).slice(0, 8) });
	const left = Object.fromEntries(await Promise.all(doomedLeft.map(async (dir) => [dir.slice(home.length + 1), await exists(dir)])));
	check("侧边聊天、预览、草稿目录都没了", Object.values(left).every((present) => !present), left);
	check("留下的会话的侧边聊天还在", await exists(join(home, "sidechats", "kept", "default.json")), {});

	await press(await center('[data-ly-row="kept"]'));
	await until(`[...document.querySelectorAll('main img')].some((img)=>img.checkVisibility()&&img.complete&&img.naturalWidth>0)`);
	await pause(1200);
	const shown = await running.evaluate<{ count: number; loaded: number }>(`(()=>{const all=[...document.querySelectorAll('main img')].filter((img)=>img.checkVisibility());return {count:all.length,loaded:all.filter((img)=>img.complete&&img.naturalWidth>0).length};})()`);
	check("留下的会话里那张共用的图照常显示", shown.count >= 1 && shown.loaded === shown.count, shown);
	await shot("04_删除后_留下的会话的图还在");
	await pause(1000);
} finally {
	await stopRecording?.();
	await app?.stop();
	const passed = checks.filter((one) => one.ok).length;
	if (frames.length > 0) await encode(frames, join(out, `${stamp}_删会话清理_${passed}of${checks.length}.mp4`), undefined, 1500);
	await rm(home, { recursive: true, force: true });
	console.log(`\n${passed}/${checks.length} 通过，视频和截图在 ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}
