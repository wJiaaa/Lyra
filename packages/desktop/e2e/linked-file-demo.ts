/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里链到项目外的文件，点开要看得见——在真窗口里点，边验边录。
 *
 * 0b477053 那一轮的原样：验证截图和录屏照规矩放在桌面上，回复里用 Markdown 链接指过去，点开却只有
 * 「读不到这个文件」。文件面板的每一扇门只认项目里的路径，见 `electron/attachment-reads.ts`。
 *
 * 两段：
 *   一、存好的会话：图片、视频、行内代码里的文档，三种链接各点一次，看面板里画出来了没有；
 *       没被链过的邻居文件照旧读不到。
 *   二、活会话：本地一个假的 Chat Completions 端点现吐一条链接（新文件，快照里从没出现过），刚交付
 *       就点——这条走的是 `session-hub.ts` 的 `broadcast`，不是快照。端点写法同 `chat-completions-probe.ts`。
 *
 * 用法：node --experimental-strip-types e2e/linked-file-demo.ts [before]
 *   带 `before` 只跑第一段、只拍图，给修复前的构建用。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const BEFORE = process.argv[2] === "before";
const OUT_DIR = join(homedir(), "Desktop", "Plume外部文件链接测试");
const PORT = 9431;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PHASE = BEFORE ? "修改前" : "修改后";
const TITLE = "外部文件链接";

let app: RunningApp;
let outside = "";
let relayPort = 0;

/** 只会说一句话的模型：一行指向项目外那张图的链接，一个字一个字地流出来。 */
function relay() {
	return createServer(async (req, res) => {
		for await (const _ of req);
		console.log(`   （假端点收到 ${req.method} ${req.url}）`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		const text = `截图在这里：[活会话截图](${join(outside, "活会话截图.png")})`;
		for (const piece of text.match(/.{1,6}/gu) ?? []) {
			send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
			await pause(40);
		}
		send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		send({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } });
		res.end("data: [DONE]\n\n");
	});
}
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** 一张图、一段视频：ffmpeg 现做，是真的 PNG 和 H.264，不是手搓的字节。 */
function media(dir: string): void {
	const run = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "ignore" });
	run(["-f", "lavfi", "-i", "testsrc=s=640x360", "-frames:v", "1", join(dir, "修改前_缺陷复现.png")]);
	run(["-f", "lavfi", "-i", "testsrc=s=640x360", "-frames:v", "1", join(dir, "活会话截图.png")]);
	run(["-f", "lavfi", "-i", "testsrc=s=640x360:r=25", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", join(dir, "验证视频_3of3.mp4")]);
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	// 项目外，像桌面上那个测试目录：不在项目里，也不在 scratch、worktree 底下。
	outside = join(home, "桌面", "Plume关联记录居中测试");
	await mkdir(project, { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(project, "README.md"), "# 演示工程\n");
	media(outside);
	await writeFile(join(outside, "delivery-notes.md"), "# 交付说明\n\n第三行写着 LINKED-FILE-OK。\n");
	await writeFile(join(outside, "邻居.txt"), "没人链过我");

	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			uiLocale: "zh-CN",
			permissionMode: "full",
			projectMemory: false,
			thinking: "off",
			autoSummarizeTitle: false,
			mcpServers: [],
			hooks: [],
			appearance: { reduceMotion: "on" },
			projects: [{ id: projectId, path: project, name: "演示工程", pinned: true, lastOpenedAt: Date.now() }],
			defaultModelId: "fake/linker",
			providers: [{
				id: "fake",
				name: "假端点",
				api: "openai-chat-completions",
				baseUrl: `http://127.0.0.1:${relayPort}/v1`,
				apiKey: "probe-key",
				enabled: true,
				models: [{ id: "fake/linker", providerId: "fake", modelId: "linker", name: "linker", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
			}],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));

	const reply = [
		"已改好，关联记录每行的图标、文字和箭头现在垂直居中。",
		"",
		`[修改前截图](${join(outside, "修改前_缺陷复现.png")}) · [验证视频](${join(outside, "验证视频_3of3.mp4")})`,
		"",
		`交付说明在 \`${join(outside, "delivery-notes.md")}:3\`。`,
	].join("\n");
	const meta = {
		id: "linked-files",
		title: TITLE,
		cwd: project,
		projectId,
		projectName: "演示工程",
		createdAt: 1,
		updatedAt: Date.now(),
		modelId: "fake/linker",
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		seq: 3,
	};
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "修一下关联记录的居中" }], timestamp: 2 } },
			{ seq: 3, ts: 3, type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: 3 } },
		],
	} as never]);
}

async function shot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT_DIR, `${STAMP}_${PHASE}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   · ${file}`);
}

const unreadable = () => app.evaluate<boolean>(`/读不到这个文件|This file cannot be read/.test(document.body.innerText)`);

/** 点回复里写着这几个字的那个文件链接——真鼠标。 */
async function clickLink(label: string): Promise<void> {
	const { click } = driver(app);
	await app.evaluate(`(()=>{
		document.querySelector('[data-demo-link]')?.removeAttribute('data-demo-link');
		const links = [...document.querySelectorAll('[data-ly-file-link] a')];
		links.findLast((a) => a.textContent.includes(${JSON.stringify(label)}))?.setAttribute('data-demo-link', '');
	})()`);
	await click("[data-demo-link]");
}

/** 一段时间内轮询，拿到就停；拿不到交回最后一次看到的。 */
async function poll<T>(expression: string, ok: (value: T) => boolean, ms = 6000): Promise<T> {
	const end = Date.now() + ms;
	let value = await app.evaluate<T>(expression);
	while (!ok(value) && Date.now() < end) {
		await pause(200);
		value = await app.evaluate<T>(expression);
	}
	return value;
}

const IMAGE = `(()=>{const img=[...document.querySelectorAll('img')].find((i)=>i.src.startsWith('ly-media:')&&i.src.includes(encodeURIComponent(NAME)));return img?{w:img.naturalWidth,h:img.naturalHeight}:null;})()`;

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	const endpoint = relay();
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	relayPort = (endpoint.address() as { port: number }).port;
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const { click, until, type, submit, settled } = driver(app);
	const stop = BEFORE ? async () => {} : await startRecording(PORT, frames);
	try {
		console.log("一、存好的会话：回复里链着桌面上的截图、视频和文档");
		await pause(1200);
		await app.evaluate(`[...document.querySelectorAll("button")].find((b)=>b.textContent?.includes(${JSON.stringify(TITLE)}))?.setAttribute('data-demo-row','')`);
		await click("[data-demo-row]");
		await until(`document.querySelectorAll('[data-ly-file-link]').length >= 3`, 20000);
		await pause(1200);

		await clickLink("修改前截图");
		const image = await poll<{ w: number; h: number } | null>(IMAGE.replace("NAME", JSON.stringify("修改前_缺陷复现.png")), (v) => Boolean(v?.w));
		await pause(1000);
		check("点「修改前截图」：面板画出 640×360 的图", image?.w === 640 && image?.h === 360, JSON.stringify(image));
		check("面板里没有「读不到这个文件」", !(await unreadable()), "读不到这个文件");
		await shot("01_点开截图");

		await clickLink("验证视频");
		const video = await poll<{ w: number; state: number } | null>(
			`(()=>{const v=document.querySelector('video[src^="ly-media:"]');return v?{w:v.videoWidth,state:v.readyState}:null;})()`,
			(v) => Boolean(v?.w),
		);
		await pause(1000);
		check("点「验证视频」：面板里的视频读到了画面（宽 640）", video?.w === 640, JSON.stringify(video));
		await shot("02_点开视频");

		await clickLink("delivery-notes.md");
		const text = await poll<boolean>(`document.body.innerText.includes('LINKED-FILE-OK')`, Boolean);
		await pause(1000);
		check("点行内代码里的 `delivery-notes.md:3`：面板显示正文", text);
		await shot("03_点开行内代码里的文档");

		const neighbour = await app.evaluate<unknown>(`window.plume.files.read(${JSON.stringify(join(outside, "邻居.txt"))})`);
		check("同目录下没被链过的文件，窗口照旧读不到", neighbour === null, JSON.stringify(neighbour));

		if (!BEFORE) {
			console.log("二、活会话：模型现写一条链接，刚交付就点");
			// 一个新会话：它没有快照可言，链接只能经 `broadcast` 那条路被记下。
			await app.evaluate(`[...document.querySelectorAll("button")].find((b)=>b.textContent?.trim()==="新对话")?.setAttribute('data-demo-new','')`);
			await click("[data-demo-new]");
			await until(`document.querySelector("main textarea")`, 10000);
			await pause(800);
			await type("把那张活会话截图的链接给我");
			await pause(600);
			await submit();
			await settled();
			await pause(1200);
			await clickLink("活会话截图");
			const fresh = await poll<{ w: number; h: number } | null>(IMAGE.replace("NAME", JSON.stringify("活会话截图.png")), (v) => Boolean(v?.w), 10000);
			await pause(1200);
			check("活会话刚交付的链接，点开就画出图", fresh?.w === 640, JSON.stringify(fresh));
			await shot("04_活会话刚交付的链接");
		}
	} catch (error) {
		await shot("失败现场").catch(() => {});
		console.log(await app.evaluate<string>(`document.querySelectorAll('[data-ly-file-link]').length + ' | ' + document.body.innerText.slice(0, 600)`).catch(() => ""));
		await app.stop();
		endpoint.close();
		throw error;
	} finally {
		await stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (!BEFORE && frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_回复里的项目外文件链接_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	await app.stop();
	endpoint.close();
	process.exitCode = BEFORE || passed === checks.length ? 0 : 1;
}

await main();
