/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 进程在工具调用中途死掉，重开之后那几张卡说什么、模型看到什么。
 *
 * 杀进程用的是 SIGKILL，不是正常退出：要验的正是 `before-quit` 来不及做任何事的那一种——崩溃、
 * 断电、被强制退出。命令是真的 shell 循环，模型是本地一个假的 Anthropic 端点，它收到的请求体原样
 * 留下来做断言：「模型看到了什么」从请求里量，不从界面上猜。
 *
 * 三次启动、同一份 profile：
 *   1. 一条一秒打印一行的命令跑到第 3 行，强杀；
 *   2. 重开：那张卡说「被打断」并带着已有的输出；接着说一句话，模型的请求里有那段输出。
 *      然后让模型同时发一条要审批的 `rm` 和一条排在它后面的命令，审批卡出来时强杀；
 *   3. 重开：`rm` 是「等审批时退出、没执行」，后一条是「还没开始」，两张卡都是灰的「已停止」。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/interrupted-calls-demo.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume中断调用测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9813;
const INSPECT = 9814;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Call = { id: string; command: string; description: string };
type Reply = { text: string } | { tools: Call[] };

/** 每一次模型请求的消息，按到达顺序。断言「模型看到了什么」读的就是这里。 */
const requests: unknown[][] = [];

function decide(messages: unknown[]): Reply {
	const raw = messages.map((message) => JSON.stringify(message));
	let from = 0;
	raw.forEach((text, index) => { if (/SCENE_[A-Z]+/.test(text) && !text.includes("tool_result")) from = index; });
	const tail = raw.slice(from).join("\n");
	const scene = tail.match(/SCENE_[A-Z]+/)?.[0];
	const results = (tail.match(/"tool_result"/g) ?? []).length;
	if (scene === "SCENE_BUILD") {
		if (results === 0) return { tools: [{ id: "build", command: "for i in $(seq 1 60); do echo \"step $i\"; sleep 1; done", description: "跑一遍构建" }] };
		return { text: "构建跑完了。" };
	}
	if (scene === "SCENE_AGAIN") {
		const all = raw.join("\n");
		const steps = [...all.matchAll(/step (\d+)/g)].map((match) => Number(match[1]));
		return { text: steps.length ? `上次的构建被打断了，已经跑到 step ${Math.max(...steps)}。我从头再跑一遍。` : "我不知道上次跑到了哪里。" };
	}
	if (scene === "SCENE_CLEAN") {
		if (results === 0) return { tools: [
			{ id: "clean", command: "rm -rf dist", description: "清理构建产物" },
			{ id: "after", command: "echo cleaned", description: "确认清理完成" },
		] };
		return { text: "清理完了。" };
	}
	if (scene === "SCENE_AFTER") {
		const all = raw.join("\n");
		const approval = all.includes("waiting for approval, so it never started");
		const notStarted = all.includes("exited before this call started");
		return { text: approval && notStarted ? "清理那条在等你批准时退出了，后面那条也没开始，两条都没执行。我重新发一次。" : "我不确定上次那两条执行了没有，先检查一下。" };
	}
	return { text: "好的。" };
}

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body: unknown = JSON.parse(raw);
			assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
			requests.push(body.messages);
			reply(res, decide(body.messages));
		});
	});
}

function reply(res: ServerResponse, answer: Reply) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	if ("tools" in answer) {
		answer.tools.forEach((tool, index) => {
			emit("content_block_start", { index, content_block: { type: "tool_use", id: `${tool.id}-${Date.now()}`, name: "bash", input: {} } });
			emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: tool.command, description: tool.description }) } });
			emit("content_block_stop", { index });
		});
	} else {
		emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer.text } });
		emit("content_block_stop", { index: 0 });
	}
	emit("message_delta", { delta: { stop_reason: "tools" in answer ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function writeSettings(home: string, modelPort: number, permissionMode: "full" | "ask"): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode,
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "中断调用", pinned: true, lastOpenedAt: 1 }],
	}));
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(join(cwd, "dist"), { recursive: true });
	await writeFile(join(cwd, "dist", "app.js"), "built\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: "interrupted", title: "中断调用", cwd, projectId, projectName: "中断调用", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, seq: 0, ts: 1 }] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
	await writeSettings(home, modelPort, "full");
}

const server = model();
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
/** 三次启动共用的一份 profile：`reuseHome` 起的应用 stop 时不删它，被杀之后留下的就是要验的。 */
const home = await mkdtemp(join(tmpdir(), "ly-interrupted-"));

/** 用这份 profile 起一次、打开那个会话，返回这一次里用得上的几样动作。 */
async function launch() {
	const running = await startApp({ port: PORT, inspectPort: INSPECT, reuseHome: home });
	app = running;
	stopRecording = await startRecording(PORT, frames);
	await running.evaluate("document.fonts.ready");
	const until = async (expression: string, ms = 30_000) => {
		for (let i = 0; i < ms / 100; i++) {
			if (await running.evaluate(`Boolean(${expression})`)) return;
			await pause(100);
		}
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_失败现场.png`), Buffer.from(picture.data, "base64"));
		throw new Error(`UI condition not reached: ${expression}\n${(await running.evaluate<string>(`document.body.innerText`)).slice(0, 1500)}`);
	};
	const shot = async (name: string) => {
		await running.evaluate(`[...document.querySelectorAll("main *")].filter((node)=>node.scrollHeight>node.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)).forEach((node)=>{node.scrollTop=node.scrollHeight;})`);
		await pause(500);
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	};
	const say = async (text: string) => {
		await until(`document.querySelector("main textarea")`);
		await running.evaluate(`(()=>{const field=document.querySelector("main textarea");field.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
		await pause(400);
		await running.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await running.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	};
	/** 每张工具卡：状态、有没有「已停止」、有没有红叉、展开后的全文。展开是点出来的，和人看到的是同一份。 */
	const cards = async () => {
		// 调用收在「执行命令」那一行里，卡片自己也折着：一层层点开，直到没有折着的。
		for (let round = 0; round < 4; round++) {
			const opened = await running.evaluate<number>(`(()=>{const rows=[...document.querySelectorAll("main .ly-flow-row[aria-expanded=false], [data-ly-tool] button[aria-expanded=false]")];rows.forEach((row)=>row.click());return rows.length;})()`);
			await pause(400);
			if (opened === 0) break;
		}
		return running.evaluate<{ status: string; stopped: boolean; danger: boolean; text: string }[]>(
			`[...document.querySelectorAll("[data-ly-tool]")].map((card)=>({status:card.getAttribute("data-ly-tool"),stopped:Boolean(card.querySelector('[aria-label="已停止"]')),danger:Boolean(card.querySelector('svg[class*="text-danger"]')),text:card.innerText.replace(/\\s+/g," ").trim()}))`,
		);
	};
	/** SIGKILL 主进程：`before-quit` 一行都不会跑，这正是要验的那种退出。 */
	const crash = async () => {
		const pid = await running.main<number>("process.pid");
		await stopRecording?.();
		stopRecording = undefined;
		process.kill(pid, "SIGKILL");
		await pause(500);
		await running.stop();
		app = undefined;
	};
	await until(`document.body.innerText.includes("中断调用")`);
	await running.evaluate(`[...document.querySelectorAll("a,button,[role=button]")].find((node)=>node.textContent?.trim()==="中断调用")?.click()`);
	await pause(1500);
	return { until, shot, say, cards, crash };
}

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await seed(home, address.port);

	// 1. 命令跑到一半，强杀。
	let step = await launch();
	await step.say("SCENE_BUILD 跑一下构建");
	await step.until(`document.querySelector("main .ly-flow-row[aria-expanded]")`, 20_000);
	await step.cards();
	await step.until(`document.querySelector("main")?.innerText.includes("step 3")`, 20_000);
	// 输出每秒落一次盘：等过这一秒，量到的才是盘上的那份。
	await pause(1500);
	await step.shot("01_命令跑到一半_即将强杀");
	await step.crash();

	// 2. 重开：卡片说被打断、带着输出；模型的下一次请求里也有。
	await writeSettings(home, address.port, "ask");
	step = await launch();
	const build = (await step.cards())[0];
	await step.shot("02_重开后_被打断的命令带着输出");
	check("被打断的命令不再转圈，也不是空的红叉", build?.status === "error" && /Interrupted: Plume exited while this call was running/.test(build.text), build);
	check("卡片里留着打断前已经打印的输出", /step 3/.test(build?.text ?? ""), build?.text.match(/step \d+/g));
	const asked = requests.length;
	await step.say("SCENE_AGAIN 刚才怎么了");
	await step.until(`/我从头再跑一遍|我不知道上次跑到了哪里/.test(document.querySelector("main")?.innerText ?? "")`);
	const seen = JSON.stringify(requests[asked]);
	check("模型的请求里有那条中断结果和输出", seen.includes("Interrupted: Plume exited") && /step 3/.test(seen), { bytes: seen.length });
	await pause(1000);
	await step.shot("03_模型据此说出了停在哪一步");

	await step.say("SCENE_CLEAN 清理一下构建产物");
	await step.until(`document.querySelector("[data-approval-card]")`, 20_000);
	await pause(1000);
	await step.shot("04_清理在等审批_即将强杀");
	await step.crash();

	// 3. 重开：等审批的和没开始的，都说「没执行」，都是灰的。
	step = await launch();
	const [clean, after] = (await step.cards()).slice(-2);
	await step.shot("05_重开后_两条都没执行");
	check("等审批时退出的那条：没执行、灰色已停止", clean?.stopped === true && !clean.danger && /waiting for approval, so it never started/.test(clean.text), clean);
	check("排在后面、还没开始的那条：没执行、灰色已停止", after?.stopped === true && !after.danger && /before this call started/.test(after.text), after);
	check("dist 还在：rm 确实没有执行", await readFile(join(home, "project", "dist", "app.js"), "utf8").then(() => true, () => false), "dist/app.js");
	const resumed = requests.length;
	await step.say("SCENE_AFTER 继续");
	await step.until(`/两条都没执行|先检查一下/.test(document.querySelector("main")?.innerText ?? "")`);
	check("模型据此知道两条都没执行，不用先去检查", JSON.stringify(requests[resumed]).includes("never started"), "never started");
	await pause(1200);
	await step.shot("06_模型据此直接重发");

	await stopRecording?.();
	stopRecording = undefined;
	const passed = checks.filter((item) => item.ok).length;
	await encode(frames, join(out, `${stamp}_进程中途退出后的工具调用_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过 → ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	// 验完把测试数据清掉：profile 在临时目录里，不在用户的 ~/.plume。
	await rm(home, { recursive: true, force: true });
}
