import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { test } from "node:test";
import { RemoteClient } from "@plume/client-runtime";
import { startApp, closeListeningServer } from "./app.ts";
import { click, frames, hold, openSettings, press, shot, type, until } from "./drive.ts";
import { lyraRelay } from "./lyra-relay-fixture.ts";
import { questionModel } from "./mention-question-fixture.ts";
import { replyWork, WORK_PROMPT } from "./mobile-work-fixture.ts";
import { encode, startRecording, type Frame } from "./record.ts";

/** 对话列表是不是真的停在最底下：量滚动容器本身，不看「回到底部」按钮在不在——按钮不在只说明它以为自己在底部。 */
const AT_BOTTOM = `(() => { const list = [...document.querySelectorAll("div")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight).find((e) => e.innerText.includes("DO_WORK")); return !!list && list.scrollTop + list.clientHeight >= list.scrollHeight - 2; })()`;

/** 一张 64×64 的渐变 PNG：看得出是一张图，又不用往仓库里放二进制文件。 */
function gradientPng(): string {
	const size = 64;
	const rows = Buffer.alloc(size * (size * 3 + 1));
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set([x * 4, y * 4, 200], y * (size * 3 + 1) + 1 + x * 3);
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

test("独立手机界面操作真实桌面运行时与授权", { timeout: 120_000 }, async (context) => {
	const model = questionModel(replyWork);
	model.server.listen(0, "127.0.0.1"); await once(model.server, "listening");
	const modelPort = (model.server.address() as { port: number }).port;
	const root = resolve("../mobile/dist");
	const web = createServer(async (request, response) => {
		const file = resolve(root, "." + new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/$/, "/index.html"));
		if (!file.startsWith(root + "/")) { response.writeHead(403).end(); return; }
		try { const data = await readFile(file); response.setHeader("content-type", ({ ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".ttf": "font/ttf" } as Record<string, string>)[extname(file)] ?? "application/octet-stream"); response.end(data); }
		catch { response.writeHead(404).end(); }
	});
	web.listen(0, "127.0.0.1"); await once(web, "listening");
	const webPort = (web.address() as { port: number }).port;
	const relay = await lyraRelay();
	context.after(() => relay.close());
	const app = await startApp({ port: 9393, seed: async (home) => {
		const cwd = join(home, "project"); await mkdir(cwd); await writeFile(join(cwd, "README.md"), "# Mobile QA\n");
		const id = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 880 }));
		await writeFile(join(home, "settings.json"), JSON.stringify({ projects: [{ id, name: "Plume", path: cwd }], providers: [{ id: "qa", name: "QA", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test-only-provider-key", enabled: true, models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "Test model", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false, supportsImages: true }] }], defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", appearance: { theme: "dark" } }));
	} });
	context.after(async () => { await app.stop(); await closeListeningServer(web); await closeListeningServer(model.server); });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	/**
	 * 同一屏再拍一张亮色：手机跟随系统，亮色是很多人真正看到的那一套，只验暗色等于只验了一半。
	 * 切的是桌面的外观设置而不是 CDP 的 setEmulatedMedia——后者在 Electron 里不改 prefers-color-scheme，
	 * 设置会写进 nativeTheme，这一页的媒体查询跟着变。
	 */
	async function lightShot(name: string) {
		const theme = (value: string) => app.evaluate(`window.plume.settings.get().then((s) => window.plume.settings.save({ ...s, appearance: { ...s.appearance, theme: ${JSON.stringify(value)} } }))`);
		await theme("light");
		await until(app, "!matchMedia('(prefers-color-scheme: dark)').matches");
		await frames(app, 20); await shot(app, `${stamp}-${name}-light`);
		await theme("dark");
		await until(app, "matchMedia('(prefers-color-scheme: dark)').matches");
		await frames(app, 10);
	}
	/**
	 * 一段动作里某个元素逐帧的位移和透明度。`target` 每帧重新求值：换页时容器是新挂载的那一个。
	 * 量的是用户看到的那段动画本身——只看终态，动画整个没播也是绿的。
	 */
	let samples = 0;
	async function sample(target: string, action: () => Promise<void>): Promise<Array<{ x: number; y: number; o: number; r: number }>> {
		const slot = `__samples${samples++}`;
		await app.evaluate(`(() => { const out = window.${slot} = []; const end = performance.now() + 900; const tick = () => { const e = ${target}; if (e) { const style = getComputedStyle(e); const m = new DOMMatrix(style.transform === "none" ? "" : style.transform); out.push({ x: Math.round(m.m41 * 10) / 10, y: Math.round(m.m42 * 10) / 10, o: Math.round(Number(style.opacity) * 100) / 100, r: Math.round(Math.atan2(m.m12, m.m11) * 180 / Math.PI) }); } if (performance.now() < end) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
		await action();
		await new Promise((resolve) => setTimeout(resolve, 950));
		return app.evaluate(`window.${slot}`);
	}
	const PAGE = `document.querySelector('[data-testid="page"]')`;
	const video: Frame[] = [];
	const stopRecording = process.env.PLUME_E2E_ARTIFACTS ? await startRecording(9393, video) : null;
	context.after(async () => { await stopRecording?.(); if (video.length > 1 && process.env.PLUME_E2E_ARTIFACTS) await encode(video, join(process.env.PLUME_E2E_ARTIFACTS, `${stamp}-mobile-flow.mp4`)); });
	await openSettings(app, "手机连接");
	await type(app, 'input[aria-label="监听端口"]', "4519");
	await click(app, '[role="switch"][aria-label="允许手机访问"]');
	await until(app, 'Boolean(document.querySelector(\'img[alt="手机配对二维码"]\'))');
	await frames(app, 20);
	await shot(app, `${stamp}-desktop-pairing`);
	await type(app, 'input[aria-label="中转服务器"]', relay.url);
	await click(app, 'button', "保存");
	await until(app, 'document.body.innerText.includes("已连上中转，等手机连进来")');
	// 配了中转，二维码默认就该带中转这条路——手机多半是因为不在同一网络才要扫它。
	await until(app, `document.querySelector('[aria-label="手机从哪里连过来"]')?.textContent?.includes(${JSON.stringify(relay.url)}) ?? false`);
	await frames(app, 10); await shot(app, `${stamp}-desktop-relay`);
	await app.evaluate("[...document.querySelectorAll('button')].find((e) => e.textContent === '重置令牌')?.scrollIntoView({ block: 'center' })");
	await frames(app, 10); await shot(app, `${stamp}-desktop-token`);
	const access = await app.evaluate<{ token: string }>("window.plume.mobile.status()");
	const rpc = new RemoteClient();
	context.after(() => rpc.disconnect());
	await rpc.connect({ url: "http://127.0.0.1:4519", token: access.token });
	assert.ok(!JSON.stringify(rpc.getSnapshot().bootstrap).includes("test-only-provider-key"), "Bootstrap 不包含提供商凭据");
	await assert.rejects(rpc.createSession("../outside", "qa/model"), /Project no longer exists/);
	await assert.rejects(rpc.createSession(rpc.getSnapshot().bootstrap!.projects[0]!.id, "missing/model"), /Model no longer exists/);
	await app.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	// 系统语言给英文：手机界面默认中文，不跟系统走。下面的选择器全是中文，默认一旦变回跟随系统，这条用例第一步就停。
	await app.send("Emulation.setLocaleOverride", { locale: "en-US" });
	await app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await app.send("Page.navigate", { url: `http://127.0.0.1:${webPort}` });
	await until(app, 'Boolean(document.querySelector(\'input[aria-label="桌面地址"]\'))');
	await frames(app, 30); await shot(app, `${stamp}-mobile-connect`); await lightShot("mobile-connect");
	// 界面这条走中转，上面的 rpc 走直连：两条路都要落到同一个桌面会话运行时上。
	await click(app, '[role="button"][aria-label="经中转"]');
	await until(app, 'Boolean(document.querySelector(\'input[aria-label="中转服务器地址"]\'))');
	await type(app, 'input[aria-label="中转服务器地址"]', relay.url);
	await type(app, 'input[aria-label="配对令牌"]', access.token);
	await click(app, '[role="button"][aria-label="连接电脑"]');
	await until(app, 'Boolean(document.querySelector(\'[aria-label="新会话"]\'))');
	assert.ok(relay.hellos.some((hello) => hello.role === "mobile"), "手机界面经中转进房");
	await frames(app, 20); await shot(app, `${stamp}-mobile-empty`);
	await click(app, '[role="button"][aria-label="新会话"]');
	await until(app, 'Boolean(document.querySelector(\'[role="button"][aria-label="开始会话"]\'))');
	await frames(app, 30); await shot(app, `${stamp}-mobile-new-session`);
	const push = await sample(PAGE, () => click(app, '[role="button"][aria-label="开始会话"]'));
	await until(app, 'Boolean(document.querySelector(\'textarea[aria-label="给 Plume 发消息…"]\'))');
	assert.ok(push.some((frame) => frame.x > 8 && frame.o < 1), `进聊天页从右边滑入：${JSON.stringify(push)}`);
	assert.deepEqual({ x: push.at(-1)!.x, o: push.at(-1)!.o }, { x: 0, o: 1 }, "滑入后停在原位");
	await type(app, 'textarea[aria-label="给 Plume 发消息…"]', "ASK_OWNER");
	await click(app, '[role="button"][aria-label="发送消息"]');
	await until(app, 'document.body.innerText.includes("请选择本次实现方式")');
	await frames(app, 20); await shot(app, `${stamp}-mobile-approval`); await lightShot("mobile-approval");
	assert.equal(await app.evaluate<string | null>(`document.querySelector('[data-testid="running-line"]')?.textContent ?? null`), "等待你的回答", "等人回答时运行行和桌面一样换成「等待你的回答」");
	await click(app, '[role="radio"]', "更新实现");
	await click(app, '[role="button"][aria-label="提交回答"]');
	await until(app, 'document.body.innerText.includes("原会话已收到回答。")');
	await shot(app, `${stamp}-mobile-chat`);
	assert.ok(model.requests.some((request) => JSON.stringify(request.messages).includes("更新实现")), "手机的回答经过真实 provider 请求");
	// 手机自己发图：拦下系统的选文件对话框，把一张图塞进图片选择器建的那个 input——人选完图之后走的是同一条路。
	await app.send("Page.setInterceptFileChooserDialog", { enabled: true });
	await click(app, '[role="button"][aria-label="添加图片"]');
	await click(app, '[role="button"]', "从相册选择");
	await until(app, 'Boolean(document.querySelector(\'input[data-testid="file-input"]\'))');
	await app.evaluate(`(() => {
		const bin = atob(${JSON.stringify(gradientPng())});
		const transfer = new DataTransfer();
		transfer.items.add(new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], "gradient.png", { type: "image/png" }));
		const input = document.querySelector('input[data-testid="file-input"]');
		input.files = transfer.files;
		input.dispatchEvent(new Event("change"));
	})()`);
	await until(app, 'Boolean(document.querySelector(\'[aria-label="移除图片"]\'))');
	await type(app, 'textarea[aria-label="给 Plume 发消息…"]', "看看这张图");
	await frames(app, 20); await shot(app, `${stamp}-mobile-attach`);
	const asked = model.requests.length;
	await click(app, '[role="button"][aria-label="发送消息"]');
	await until(app, 'Boolean(document.querySelector(\'img[src^="data:image/jpeg"]\')) && !document.querySelector(\'[aria-label="移除图片"]\')');
	while (model.requests.length === asked) await new Promise((resolve) => setTimeout(resolve, 50));
	await until(app, '!document.querySelector(\'[data-testid="running-line"]\')');
	assert.ok(JSON.stringify(model.requests.at(-1)).includes("image/jpeg"), "发前压成 JPEG，图随消息到了模型");
	// 真干活的一轮：做完以后过程折成一行，最终回答带代码块和结尾。
	await type(app, 'textarea[aria-label="给 Plume 发消息…"]', WORK_PROMPT);
	await click(app, '[role="button"][aria-label="发送消息"]');
	// 跑命令那一步模型会停一下（见 mobile-work-fixture），计划条趁这时候拍。
	await until(app, `Boolean([...document.querySelectorAll('[role="button"]')].find((e) => (e.getAttribute("aria-label") || "").startsWith("计划 ")))`, 1800);
	await until(app, AT_BOTTOM, 120);
	// 运行行是消息流的最后一行，跟着内容滚；说法和桌面 RunningIndicator 一样：「短语… · 计时」，不写「正在工作」。
	const runningLine = await app.evaluate<string | null>(`(() => { const list = [...document.querySelectorAll("div")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.innerText.includes("DO_WORK")).at(-1); return list?.querySelector('[data-testid="running-line"]')?.textContent ?? null; })()`);
	assert.match(runningLine ?? "", /^[A-Z][^…]*…·\d+(s|m \d{2}s)/, `运行行在消息列表里，照桌面的格式：${runningLine}`);
	await frames(app, 10); await shot(app, `${stamp}-mobile-plan`);
	// 回答前半段落下时运行行和桌面一样收起；字停住超过 STALL_MS 它回来（两段之间停多久见 mobile-work-fixture）。
	const line = 'Boolean(document.querySelector(\'[data-testid="running-line"]\'))';
	await until(app, 'document.body.innerText.includes("手机端这次做了三件事")', 1800);
	assert.ok(!await app.evaluate<boolean>(line), "回复正在出字，运行行收起");
	await frames(app, 10); await shot(app, `${stamp}-mobile-answering`);
	await until(app, `${line} && !document.body.innerText.includes("有问题随时说。")`, 400);
	await frames(app, 10); await shot(app, `${stamp}-mobile-answer-stalled`);
	/*
	 * 后半段（约 100 字）一次到达，照桌面的节奏分很多帧放出来、新字淡入，而不是整段蹦出来。量的是屏幕上
	 * 那段回答逐帧的字数（运行行的字扣掉）和有没有半透明的字。
	 */
	const reveal = await app.evaluate<{ lengths: number[]; faded: number }>(`new Promise((resolve) => {
		const lengths = []; let faded = 0; const end = performance.now() + 2500;
		const tick = () => {
			const list = [...document.querySelectorAll("div")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.innerText.includes("DO_WORK")).at(-1);
			const text = list ? list.innerText : "";
			const at = text.indexOf("手机端这次做了三件事");
			const line = list?.querySelector('[data-testid="running-line"]')?.innerText ?? "";
			lengths.push(at < 0 ? 0 : text.slice(at).replace(line, "").length);
			if (list && [...list.querySelectorAll("span")].some((e) => /rgba\\(.*, 0?\\.\\d+\\)/.test(getComputedStyle(e).color))) faded++;
			if (performance.now() < end && !text.includes("有问题随时说。")) requestAnimationFrame(tick); else resolve({ lengths, faded });
		};
		tick();
	})`);
	const steps = new Set(reveal.lengths).size;
	assert.ok(steps >= 6 && reveal.lengths.every((n, i) => i === 0 || n >= reveal.lengths[i - 1]! - 2), `后半段分帧放出、只增不减：${steps} 档 ${JSON.stringify(reveal.lengths.slice(-40))}`);
	assert.ok(reveal.faded >= 3, `放字时有正在淡入的字：${reveal.faded} 帧`);
	await until(app, `document.body.innerText.includes("有问题随时说。") && [...document.querySelectorAll('[role="button"]')].some((e) => (e.getAttribute("aria-label") || "").includes("修改文件") && e.getAttribute("aria-label") !== "修改文件 README.md")`, 1800);
	assert.ok(!await app.evaluate<boolean>(`Boolean([...document.querySelectorAll('[role="button"]')].find((e) => (e.getAttribute("aria-label") || "").startsWith("计划 ")))`), "计划做完、任务停了，计划条收起");
	await frames(app, 30); await shot(app, `${stamp}-mobile-work`); await lightShot("mobile-work");
	assert.ok(await app.evaluate<boolean>('document.body.innerText.includes("+3") && !document.body.innerText.includes("−0")'), "改动行数挂在摘要上，为零的一侧不写");
	await until(app, AT_BOTTOM, 120);
	assert.ok(!await app.evaluate<boolean>(`Boolean(document.querySelector('[aria-label="回到底部"]'))`), "回答一下子长出来时仍跟到底部");
	const chevron = `(() => { const fold = [...document.querySelectorAll('[role="button"]')].find((e) => (e.getAttribute("aria-label") || "").includes("修改文件")); return fold && [...fold.querySelectorAll("div")].filter((e) => e.style.transform.includes("rotate")).at(-1); })()`;
	const nestedRow = `(() => { let e = [...document.querySelectorAll('[role="button"]')].find((e) => e.getAttribute("aria-label") === "修改文件 README.md"); while (e && !e.style.transform.includes("translateY")) e = e.parentElement; return e; })()`;
	const turn = sample(chevron, () => new Promise((resolve) => setTimeout(resolve, 600)));
	const drop = await sample(nestedRow, () => click(app, '[role="button"]', "更新清单 2 个", "includes"));
	const turned = await turn;
	await until(app, `Boolean([...document.querySelectorAll('[role="button"]')].find((e) => e.getAttribute("aria-label") === "修改文件 README.md"))`);
	assert.ok(drop.some((frame) => frame.o < 1 && frame.y < 0) && drop.at(-1)!.o === 1 && drop.at(-1)!.y === 0, `展开后过程行淡入落下：${JSON.stringify(drop)}`);
	assert.ok(turned.some((frame) => Math.abs(frame.r) > 10 && Math.abs(frame.r) < 170) && Math.abs(turned.at(-1)!.r) === 180, `展开箭头转过去而不是换图标：${JSON.stringify(turned)}`);
	await frames(app, 20); await shot(app, `${stamp}-mobile-work-expanded`);
	await click(app, '[role="button"]', "修改文件 README.md");
	await until(app, 'document.body.innerText.includes("手机端改的这一行。")');
	await frames(app, 30); await shot(app, `${stamp}-mobile-diff`);
	await press(app, "Escape", 27);
	await until(app, '!document.body.innerText.includes("手机端改的这一行。")');
	await click(app, '[role="button"]', "执行命令 wc -l README.md");
	await until(app, 'document.body.innerText.includes("退出码 0")');
	await frames(app, 30); await shot(app, `${stamp}-mobile-terminal`);
	await press(app, "Escape", 27);
	await until(app, '!document.body.innerText.includes("退出码 0")');
	const list = await app.evaluate<Array<{ id: string }>>("window.plume.sessions.list()");
	assert.equal(list.length, 1, "桌面与手机共用同一份存储");
	await click(app, '[aria-label="会话操作"]');
	await until(app, 'Boolean(document.querySelector(\'input[aria-label="会话名称"]\'))');
	await frames(app, 30); await shot(app, `${stamp}-mobile-actions`); await lightShot("mobile-actions");
	await type(app, 'input[aria-label="会话名称"]', "手机联调");
	await frames(app, 10); await shot(app, `${stamp}-mobile-actions-rename`);
	await click(app, '[aria-label="重命名"]');
	await until(app, 'document.body.innerText.includes("手机联调")');
	const pop = await sample(PAGE, () => click(app, '[aria-label="返回"]'));
	assert.ok(pop.some((frame) => frame.x < -8 && frame.o < 1), `返回时列表从左边滑入：${JSON.stringify(pop)}`);
	await frames(app, 10); await shot(app, `${stamp}-mobile-sessions`); await lightShot("mobile-sessions");
	await hold(app, '[role="button"]', "手机联调");
	await until(app, `Boolean([...document.querySelectorAll('[role="button"]')].find((e) => e.getAttribute("aria-label") === "归档会话"))`);
	await frames(app, 30); await shot(app, `${stamp}-mobile-hold-actions`); await lightShot("mobile-hold-actions");
	await press(app, "Escape", 27);
	await until(app, `![...document.querySelectorAll('[role="button"]')].some((e) => e.getAttribute("aria-label") === "归档会话")`);
	await click(app, '[aria-label="设置"]');
	await frames(app, 10); await shot(app, `${stamp}-mobile-settings`); await lightShot("mobile-settings");
	await click(app, '[aria-label="断开并忘记这台电脑"]');
	await until(app, 'Boolean(document.querySelector(\'input[aria-label="桌面地址"]\'))');
});
