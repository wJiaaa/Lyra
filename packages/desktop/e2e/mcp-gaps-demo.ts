/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * MCP 客户端补齐的三项，在真窗口里各走一遍：prompt 进 `/` 菜单并能发出、elicitation 弹表单并把
 * 填的值交回工具、设置页的登录按钮走完 OAuth。
 *
 * 用到的 MCP 服务器是 `mcp-gaps-server.ts` 里那份源码，写进临时目录、跑完连目录一起删；模型是本进程
 * 里一台说 Anthropic SSE 的假服务器。应用跑在 `startApp` 给的一次性 PLUME_HOME 里，不碰 `~/.plume`。
 * 登录那一段会真的用系统浏览器打开授权页：测试授权服务器自动同意并跳回本机回调，浏览器里留下一页
 * 「可以关掉了」。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/mcp-gaps-demo.ts [prompts,elicitation,oauth]`
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { closeListeningServer, startApp, stopProcessGroup, type RunningApp } from "./app.ts";
import { click, closeSettings, frames as settleFrames, openSession, openSettings, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";
import { MCP_GAPS_SERVER } from "./mcp-gaps-server.ts";

const OUT = join(homedir(), "Desktop", "PlumeMCP补齐测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9811;
const SESSION = "mcp-gaps";
const parts = new Set((process.argv[2] ?? "prompts,elicitation,oauth").split(","));

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

/** 模型每次收到的请求体，按先后。 */
const requests: { messages: { role: string; content: unknown }[] }[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
			requests.push(body);
			// 只看最后一条助手消息之后的那几条：用户这一句之后可能还跟着运行时附的 `<env>`。
			const last = body.messages.findLastIndex((message) => message.role === "assistant");
			const tail = JSON.stringify(body.messages.slice(last + 1));
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes("you are the demo user")) reply(res, "登录后的工具调用成功了。");
			else if (tail.includes('"tool_result"')) reply(res, "工具拿到了你填的资料。");
			else if (tail.includes("ELICIT")) reply(res, "", { id: "call-ask", name: "mcp__demo__ask_profile" });
			else if (tail.includes("WHOAMI")) reply(res, "", { id: "call-whoami", name: "mcp__secure__whoami" });
			else reply(res, "收到，这就看。");
		});
	});
}

function reply(res: ServerResponse, text: string, tool?: { id: string; name: string }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 50, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number, mcpOrigin: string): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# mcp\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "MCP 补齐", cwd, projectId, projectName: "MCP", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "开始吧。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [
			{ id: "demo", name: "Demo", transport: "http", url: `${mcpOrigin}/mcp`, enabled: true },
			{ id: "secure", name: "Secure", transport: "http", url: `${mcpOrigin}/secure/mcp`, enabled: true },
		],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "MCP", pinned: true, lastOpenedAt: 1 }],
	}));
}

/** 把 MCP 测试服务器写进临时目录起起来，等它报出端口。 */
async function startMcpServer(dir: string): Promise<{ child: ChildProcess; origin: string }> {
	const script = join(dir, "server.mjs");
	await writeFile(script, MCP_GAPS_SERVER);
	const sdk = pathToFileURL(dirname(createRequire(join(import.meta.dirname, "..", "..", "core", "package.json")).resolve("@modelcontextprotocol/sdk/client/index.js"))).href.replace(/\/client$/, "");
	const child = spawn(process.execPath, [script], { env: { ...process.env, SDK: sdk }, stdio: ["ignore", "pipe", "inherit"], detached: true });
	const origin = await new Promise<string>((resolve, reject) => {
		let out = "";
		child.stdout!.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const found = /LISTENING (\S+)/.exec(out);
			if (found) resolve(found[1]!);
		});
		child.once("exit", (code) => reject(new Error(`MCP test server exited with ${code}`)));
	});
	return { child, origin };
}

const modelServer = model();
let app: RunningApp | undefined;
let mcp: { child: ChildProcess; origin: string } | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];
const scratch = await mkdtemp(join(tmpdir(), "plume-mcp-gaps-"));
let shots = 0;

/** 窗口截图，带时间戳和序号，落在 `OUT`。 */
async function snap(name: string): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shots += 1;
	await writeFile(join(OUT, `${STAMP}_${String(shots).padStart(2, "0")}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 停一会儿，让录像里看得清这一步。 */
const beat = (ms = 1000) => pause(ms);

const textareaValue = () => app!.evaluate<string>(`document.querySelector("main textarea")?.value ?? ""`);

async function typeInComposer(text: string): Promise<void> {
	await click(app!, "main textarea");
	await app!.send("Input.insertText", { text });
	await settleFrames(app!, 4);
}

async function clearComposer(): Promise<void> {
	await click(app!, "main textarea");
	await app!.evaluate(`(()=>{const f=document.querySelector("main textarea");f.select();})()`);
	await press(app!, "Backspace", 8);
}

try {
	await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
	const address = modelServer.address();
	assert.ok(address && typeof address !== "string");
	mcp = await startMcpServer(scratch);
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port, mcp!.origin) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await beat();

	if (parts.has("prompts")) {
		console.log("— 1. MCP prompt 进 / 菜单");
		await typeInComposer("/mcp");
		await until(app, `document.querySelector('[data-command-kind="prompt"]')`, 1800);
		await beat(1200);
		const menu = await app.evaluate<{ rows: string[]; group: string }>(`(()=>{
			const rows=[...document.querySelectorAll('[data-command-kind="prompt"]')].map(e=>e.getAttribute('aria-label')||'');
			const group=[...document.querySelectorAll('.ly-command-menu div')].map(e=>e.textContent||'').find(t=>t==='MCP 提示词')||'';
			return {rows,group};
		})()`);
		check("/ 菜单里出现 mcp__demo__review，来自 Demo", menu.rows.some((row) => row.startsWith("mcp__demo__review") && row.includes("Demo")), menu);
		await snap("prompt菜单");

		await press(app, "Tab", 9);
		await beat(600);
		const picked = await textareaValue();
		check("Tab 选中后输入框是 /mcp__demo__review ", picked === "/mcp__demo__review ", picked);
		const hint = await app.evaluate<string>(`[...document.querySelectorAll('main *')].map(e=>e.textContent||'').find(t=>t.trim()==='<code> [language]')||''`);
		check("参数提示写着 <code> [language]", hint.trim() === "<code> [language]", hint);
		await snap("prompt参数提示");

		await press(app, "Enter", 13);
		await beat(900);
		const toast = await app.evaluate<string>(`document.querySelector('[data-ly-toaster]')?.textContent ?? ''`);
		const kept = await textareaValue();
		check("缺必填参数时不发，提示缺 code，草稿留着", toast.includes("还缺参数") && toast.includes("code") && kept.startsWith("/mcp__demo__review"), { toast, kept });
		await snap("prompt缺参数");

		const before = requests.length;
		await app.send("Input.insertText", { text: 'code="def f(x): return x / 0" language=python' });
		await beat(900);
		await press(app, "Enter", 13);
		await until(app, `[...document.querySelectorAll('.ly-user-bubble')].some(e=>e.textContent.includes('请审查这段 python'))`, 1800);
		await beat(1500);
		// 最后一条可能是运行时附的 `<env>`，所以在整份请求里找那条用户消息。
		const sent = requests.slice(before).flatMap((request) => request.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)));
		const expanded = sent.find((one) => one.includes("请审查这段 python"));
		check("模型收到的是服务器展开的消息，参数填进去了", Boolean(expanded?.includes("def f(x): return x / 0")), expanded?.slice(0, 300));
		const bubble = await app.evaluate<string>(`[...document.querySelectorAll('.ly-user-bubble')].at(-1)?.textContent ?? ''`);
		check("气泡里是展开后的内容", bubble.includes("请审查这段 python") && bubble.includes("def f(x)"), bubble);
		await snap("prompt已发出");
		await clearComposer();
	}

	if (parts.has("elicitation")) {
		console.log("— 2. elicitation 弹表单，填的值交回工具");
		const stats = async () => (await (await fetch(`${mcp!.origin}/debug/stats`)).json()) as { elicitations: unknown[] };
		const replies = () => app!.evaluate<number>(`document.querySelector('main').textContent.split('工具拿到了你填的资料').length - 1`);
		const FORM = "[data-ly-mcp-form]";
		/** 发一句让模型去调那个会反问的工具，等表单弹出来。 */
		const ask = async (text: string) => {
			await typeInComposer(text);
			await press(app!, "Enter", 13);
			await until(app!, `document.querySelector(${JSON.stringify(FORM)})`, 1800);
			await beat(1200);
		};
		/** 等这一轮收尾：工具拿到回答、模型说完那句话、卡片收走。 */
		const settled = async (count: number) => {
			await until(app!, `document.querySelector('main').textContent.split('工具拿到了你填的资料').length - 1 >= ${count} && !document.querySelector(${JSON.stringify(FORM)})`, 1800);
			await beat(1200);
		};

		await ask("ELICIT 第一次：填好交上去");
		const card = await app.evaluate<{ title: string; fields: string[]; options: string[]; note: string }>(`(()=>{
			const card=document.querySelector('[data-approval-card]');
			return {
				title: card.querySelector('[data-approval-title]')?.textContent ?? '',
				fields: [...card.querySelectorAll('[data-ly-form-field]')].map(e=>e.getAttribute('data-ly-form-field')),
				options: [...card.querySelectorAll('[data-ly-form-option]')].map(e=>e.textContent),
				note: card.textContent,
			};
		})()`);
		check("完全访问模式下表单照样弹出，标题说是 Demo 在要", card.title === "Demo 需要你填写", card.title);
		check("四格按 schema 的顺序画出来，单选用的是 enumNames", card.fields.join() === "name,color,age,subscribe" && card.options.join() === "红,绿,蓝", card);
		check("卡片上有服务器的那句话", card.note.includes("填一下你的资料，工具要用"), card.note.slice(0, 120));
		await snap("elicitation表单");

		await click(app, `${FORM} button[type="submit"]`);
		await beat(900);
		const problems = await app.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-ly-form-problem]')].map(e=>[e.getAttribute('data-ly-form-problem'),e.textContent]))`);
		check("必填没填就提交：名字、年龄两格报必填，卡片不收", problems.name === "这一项必填" && problems.age === "这一项必填" && Boolean(await app.evaluate(`!!document.querySelector(${JSON.stringify(FORM)})`)), problems);
		await snap("elicitation必填提示");

		await type(app, `${FORM} #ly-form-name`, "Ada");
		await type(app, `${FORM} #ly-form-age`, "36.5");
		await click(app, `${FORM} button[type="submit"]`);
		await beat(700);
		const ageProblem = await app.evaluate<string>(`document.querySelector('[data-ly-form-problem="age"]')?.textContent ?? ''`);
		check("年龄填小数：报要填整数", ageProblem === "这里要填整数", ageProblem);
		await type(app, `${FORM} #ly-form-age`, "36");
		await click(app, '[data-ly-form-option="green"]');
		await click(app, '[data-ly-form-field="subscribe"] label');
		await beat(900);
		await snap("elicitation已填好");
		await click(app, `${FORM} button[type="submit"]`);
		await settled(1);
		let seen = (await stats()).elicitations;
		check("服务器收到 accept 和填的值，年龄是数字", JSON.stringify(seen[0]) === JSON.stringify({ action: "accept", content: { name: "Ada", color: "green", age: 36, subscribe: true } }), seen[0]);
		const result = await app.evaluate<string>(`document.querySelector('main').textContent`);
		check("工具结果回到了对话里，模型接着说完", result.includes("工具拿到了你填的资料"), await replies());
		await snap("elicitation已交回");

		await ask("ELICIT 第二次：拒绝提供");
		await click(app, `${FORM} button`, "拒绝提供");
		await settled(2);
		seen = (await stats()).elicitations;
		check("点「拒绝提供」，服务器收到 decline", JSON.stringify(seen[1]) === JSON.stringify({ action: "decline" }), seen[1]);

		await ask("ELICIT 第三次：取消");
		await click(app, `${FORM} button`, "取消");
		await settled(3);
		seen = (await stats()).elicitations;
		check("点「取消」，服务器收到 cancel", JSON.stringify(seen[2]) === JSON.stringify({ action: "cancel" }), seen[2]);
		await snap("elicitation三种回答之后");
	}

	if (parts.has("oauth")) {
		console.log("— 3. 设置页登录走完 OAuth");
		type Stats = { registrations: number; authorizations: number; codeExchanges: number; refreshes: number; resources: (string | null)[]; clients: number };
		const stats = async () => (await (await fetch(`${mcp!.origin}/debug/stats`)).json()) as Stats;
		const CARD = '[data-mcp-server="secure"]';
		const cardText = (id: string) => app!.evaluate<string>(`document.querySelector('[data-mcp-server="${id}"]')?.textContent ?? ''`);
		// 先让会话自己连一遍：它手上那份才是 agent 真正用的，登录后要看它换没换上。
		await openSettings(app, "插件");
		await click(app, '[data-tab="mcp"]');
		await until(app, `document.querySelector('${CARD} [data-mcp-signin="needed"]')`, 1800);
		await beat(1200);
		const before = await cardText("secure");
		check("没登录的远程服务器显示「需要登录」和登录按钮", before.includes("需要登录") && before.includes("登录"), before);
		const demo = await cardText("demo");
		check("不用登录的那台照常连着，不受影响", demo.includes("1 个工具") && !demo.includes("需要登录"), demo);
		check("还没登录时没有在后台注册客户端", (await stats()).registrations === 0, await stats());
		await snap("oauth需要登录");

		await click(app, `${CARD} [data-mcp-signin] button`);
		// 本机的授权服务器自动同意，整趟不到一秒：点下去立刻量，不等。
		await settleFrames(app, 3);
		const waiting = await cardText("secure");
		check("点登录后提示去浏览器里授权", waiting.includes("在浏览器里完成授权"), waiting);
		await snap("oauth等待浏览器");
		// 系统浏览器打开授权页，测试授权服务器自动同意、跳回本机回调。
		await until(app, `document.querySelector('${CARD} [data-mcp-signin="signed-in"]')`, 3600);
		await beat(1200);
		const signed = await cardText("secure");
		let seen = await stats();
		check("登录完成：卡片变成已登录、连上 1 个工具、给出退出登录", signed.includes("1 个工具") && signed.includes("退出登录") && !signed.includes("需要登录"), signed);
		check("走了一次注册、一次授权、一次换令牌", seen.registrations === 1 && seen.authorizations === 1 && seen.codeExchanges === 1, seen);
		check("授权请求带着 resource，指向这台 MCP 服务器", seen.resources[0] === `${mcp!.origin}/secure/mcp`, seen.resources);
		const vault = await readFile(join(app.home, "credentials.json"), "utf8");
		const settingsFile = await readFile(join(app.home, "settings.json"), "utf8");
		check("令牌加密进了 vault，settings.json 里没有", /"mcp-oauth:secure": "v1:/.test(vault) && !/[ar]t-[0-9a-f]{8}-/.test(vault + settingsFile) && !settingsFile.includes("access_token"), { vaultKeys: Object.keys(JSON.parse(vault).secrets) });
		await snap("oauth已登录");

		// 会话用的是登录来的令牌：让模型调一下要登录的那个工具。
		await closeSettings(app);
		await openSession(app, SESSION);
		await typeInComposer("WHOAMI 调一下要登录的工具");
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('main').textContent.includes('登录后的工具调用成功了')`, 1800);
		await beat(1200);
		const whoami = requests.flatMap((request) => request.messages).map((message) => JSON.stringify(message.content)).find((one) => one.includes("you are the demo user"));
		check("会话重连后带着令牌调到了 mcp__secure__whoami", Boolean(whoami), whoami?.slice(0, 160));
		await snap("oauth会话里调用");

		await openSettings(app, "插件");
		await click(app, '[data-tab="mcp"]');
		await until(app, `document.querySelector('${CARD} [data-mcp-signin="signed-in"]')`, 1800);
		await click(app, `${CARD} [data-mcp-signin] button`);
		await until(app, `document.querySelector('${CARD} [data-mcp-signin="needed"]')`, 1800);
		await beat(1000);
		check("退出登录：回到需要登录", (await cardText("secure")).includes("需要登录"), await cardText("secure"));
		await snap("oauth已退出");

		await click(app, `${CARD} [data-mcp-signin] button`);
		await until(app, `document.querySelector('${CARD} [data-mcp-signin="signed-in"]')`, 3600);
		await beat(1000);
		seen = await stats();
		check("再登录一次：沿用注册信息，没有重新注册", seen.registrations === 1 && seen.clients === 1 && seen.authorizations === 2 && seen.codeExchanges === 2, seen);
		await snap("oauth再次登录");
	}
} catch (error) {
	check("验证脚本跑完", false, String(error));
	console.error(error);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(modelServer);
	if (mcp) await stopProcessGroup(mcp.child);
	await rm(scratch, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${STAMP}_MCP补齐_${[...parts].join("+")}_${pass}of${checks.length}`;
	await writeFile(join(OUT, `${name}.json`), JSON.stringify({ checks }, null, 2));
	if (recorded.length) await encode(recorded, join(OUT, `${name}.mp4`), 30);
	console.log(`证据：${join(OUT, name)}（${recorded.length} 帧）`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
