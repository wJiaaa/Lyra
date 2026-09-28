/**
 * The thinking line, recorded: what a turn actually looks like now.
 *
 * `node --experimental-strip-types e2e/thinking-typing-probe.ts`
 *
 * A scripted model drives one turn through every shape the transcript has to hold — reasoning
 * before a call, reasoning that arrives in one burst rather than a stream, a sentence spoken in
 * the middle of the work, and the answer at the end — while the window is screencast frame by
 * frame and assembled into a video. The point is the pacing, and pacing is the one thing a
 * screenshot cannot show.
 *
 * The frames come over a second debugger connection of its own. `startApp` holds the first and
 * has no way to subscribe to events; screencast is nothing but events.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { startApp } from "./app.ts";

const MODEL_PORT = 9576;
const DEBUG_PORT = 9468;
const OUT = "/tmp/plume-thinking-typing";
const FRAMES = join(OUT, `frames-${process.env.PLUME_TAKE ?? "thinking"}`);
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Step {
	thinking: string;
	/** Everything at once rather than a token at a time — a relay flushing a whole block. */
	burst?: boolean;
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
}

/*
 * One turn, in the shapes that used to be impossible to see.
 *
 * Every stretch of reasoning here except the last was drawn nowhere at all before this change:
 * a reply with calls and no prose got no row, and the single shared row held only the newest.
 */
const LONG = [
	"这段要长一点，用来看一次到达大量 token 时的节奏。",
	"先把问题重新说清楚：detailTrend 里的 auth_index 和 detailFile 的 auth_index 不是同一个口径，前者是排序后的下标，后者是原始记录的主键。两边在 isTrendMatching 里被直接比较，所以只要列表做过一次重排，匹配就会落到相邻的另一条记录上。",
	"这解释了为什么用户看到的是「偶尔错一条」而不是「全错」——只有重排发生过的会话才会命中。",
	"接下来要确认三件事。第一，detailTrend 的 auth_index 是在哪一层被赋值的，如果是在渲染层临时算出来的，那它根本不该参与匹配。第二，detailFile 的 authIndex 和 auth_index 两个字段是不是同一个东西，代码里两种写法都出现过，很可能是某次重构留下的半截改名。第三，isTrendMatching 之外还有没有别的地方做了同样的比较，如果有，修一处是不够的。",
	"先看赋值的那一层，其余两件事跟着它的答案走。",
].join("\n");

const STEPS: Step[] = [
	{
		thinking: "先看看项目结构，从目录开始，别一上来就读文件。",
		tool: { name: "ls", args: { path: "." } },
	},
	{
		thinking:
			"有 src 和 test 两块，src 下面三个文件。入口应该是 src/index.ts，先读它——看它导出什么、又依赖谁，比一个个猜要快得多。\n" +
			"读之前先想清楚要找什么：这次的问题出在匹配逻辑上，那我关心的是数据是怎么进来的、在哪一层被加工过。只看函数签名不够，得看赋值。",
		tool: { name: "read", args: { path: "src/index.ts" } },
	},
	{
		thinking: "入口只是两个 re-export，真正的东西在 detail 和 core 里。先跟用户说一声我准备怎么做，免得读了半天他不知道在干嘛。",
		text: "我先把入口和它依赖的两个模块读一遍，再决定从哪里下手。",
		tool: { name: "grep", args: { pattern: "detailTrend", path: "." } },
	},
	// The one this whole change is about: a great deal of reasoning, arriving all at once.
	{ thinking: LONG, burst: true, tool: { name: "read", args: { path: "src/detail.ts" } } },
	{
		thinking: "三处引用，两处在渲染层。",
		tool: { name: "read", args: { path: "src/core.ts" } },
	},
	{
		thinking:
			"看到了：core 里 auth_index 是常量，detail 里那个是参数传进来的。两个东西同名，但一个是数据、一个是位置。\n" +
			"再确认一遍我没弄反：detailFile 的 auth_index 来自后端记录，detailTrend 的来自列表渲染时的下标。是的，没弄反。可以下结论了。",
		text: "找到了：`detailTrend` 的 `auth_index` 是渲染时算出来的下标，`detailFile` 的是原始主键，两者在 `isTrendMatching` 里被直接比较。",
		tool: { name: "read", args: { path: "src/index.ts" } },
	},
	{
		thinking:
			"最后把修法写清楚。用户要的是能直接动手的东西，不是一句「有问题」。\n" +
			"所以要说三件事：问题是什么、为什么只是偶尔出现、改哪一行。第二件最容易被漏掉，而它恰恰是用户最困惑的地方——他一直以为是随机的。",
		text: "**问题**：两个 `auth_index` 不是同一个口径——一个是排序后的下标，一个是原始主键。列表重排过的会话就会匹配到相邻的另一条记录。\n\n**修法**：`isTrendMatching` 改用主键比较，渲染层的下标不参与匹配。",
	},
];

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Stream a string as a block's deltas, in chunks of `size` every `gap` milliseconds. */
async function stream(res: ServerResponse, index: number, kind: "thinking" | "text", value: string, size: number, gap: number): Promise<void> {
	for (let at = 0; at < value.length; at += size) {
		const slice = value.slice(at, at + size);
		const delta = kind === "thinking" ? { type: "thinking_delta", thinking: slice } : { type: "text_delta", text: slice };
		sse(res, { type: "content_block_delta", index, delta });
		await settle(gap);
	}
}

function startModel(): Server {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			const parsed = JSON.parse(body) as { messages?: { role: string }[] };
			const at = (parsed.messages ?? []).filter((m) => m.role === "assistant").length;
			const step = STEPS[Math.min(at, STEPS.length - 1)];
			// A real model takes a moment before its first token; that moment is part of the rhythm.
			await settle(600);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${at}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });

			let index = 0;
			sse(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
			if (step.burst) {
				// The whole block in one delta: what a relay does when it batches instead of streaming.
				sse(res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: step.thinking } });
			} else {
				await stream(res, index, "thinking", step.thinking, 4, 55);
			}
			sse(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
			sse(res, { type: "content_block_stop", index });
			index++;

			if (step.text) {
				sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
				await stream(res, index, "text", step.text, 3, 28);
				sse(res, { type: "content_block_stop", index });
				index++;
			}

			if (step.tool) {
				sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${at}`, name: step.tool.name, input: {} } });
				sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.args) } });
				sse(res, { type: "content_block_stop", index });
				sse(res, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } });
			} else {
				sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } });
			}
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project", "src");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "index.ts"), "export { detail } from './detail.ts'\nexport { core } from './core.ts'\n");
	await writeFile(join(project, "detail.ts"), "export const detail = (detailTrend: number) => detailTrend\n");
	await writeFile(join(project, "core.ts"), "export const core = { detailTrend: 0, auth_index: 1 }\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "local",
					name: "Local",
					baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
					api: "anthropic-messages",
					apiKey: "not-a-key",
					enabled: true,
					models: [
						{
							id: "local/scripted",
							providerId: "local",
							modelId: "scripted",
							name: "Scripted",
							contextWindow: 200000,
							maxOutputTokens: 8192,
							supportsThinking: true,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: join(home, "project"), pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			permissionMode: "full",
			thinking: "medium",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
}

/**
 * The window, frame by frame, over a debugger connection of this recorder's own.
 *
 * Frames arrive only when something was painted, so a still transcript costs nothing and the
 * timings are the real ones — which is the whole point of recording rather than screenshotting.
 */
async function recorder(app: { send<T>(method: string, params?: Record<string, unknown>): Promise<T> }): Promise<{ stop: () => Promise<{ frames: number; missed: number }> }> {
	const shots: { file: string; at: number }[] = [];
	let writing = Promise.resolve();
	let missed = 0;
	// A flag on an object rather than a bare `let`: the loop and the stopper are different closures.
	const gate = { pulling: true };

	/*
	 * Frames pulled one at a time over the app's own debugger connection.
	 *
	 * Not a screencast, and not a second connection. `Page.startScreencast` sends one frame and
	 * then nothing, whatever `Page.enable` and the frame ack say; a connection of this recorder's
	 * own answers `Page.captureScreenshot` promptly and every frame comes back black. Only the
	 * connection the app is already driving returns what is actually on screen.
	 */
	const pulling = (async () => {
		while (gate.pulling) {
			const at = performance.now() / 1000;
			const data = await app
				.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 72 })
				.then((r) => r.data)
				.catch(() => "");
			if (!data) {
				missed++;
				await settle(60);
				continue;
			}
			const file = `f${String(shots.length).padStart(5, "0")}.jpg`;
			shots.push({ file, at });
			// Off the pulling loop, so disk latency does not become the frame rate.
			writing = writing.then(() => writeFile(join(FRAMES, file), Buffer.from(data, "base64")));
		}
	})();

	return {
		stop: async () => {
			gate.pulling = false;
			await pulling;
			await writing;
			/*
			 * A concat list with a duration per frame, rather than a fixed frame rate.
			 *
			 * Frames come back at whatever rate the app can produce them, so the gaps between them
			 * are the real timings. Handing ffmpeg a constant rate would stretch the still stretches
			 * and compress the busy ones — the two things this video exists to show.
			 */
			const lines: string[] = [];
			for (const [at, shot] of shots.entries()) {
				const next = shots[at + 1];
				const seconds = next ? Math.max(0.016, Math.min(2, next.at - shot.at)) : 1.2;
				lines.push(`file '${shot.file}'`, `duration ${seconds.toFixed(3)}`);
			}
			// The concat demuxer drops the last frame unless it is named twice.
			if (shots.length > 0) lines.push(`file '${shots[shots.length - 1].file}'`);
			await writeFile(join(FRAMES, "list.txt"), `${lines.join("\n")}\n`);
			return { frames: shots.length, missed };
		},
	};
}

await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });
const model = startModel();
const app = await startApp({ port: DEBUG_PORT, seed });

/** One expression in the renderer, for the checks the video cannot make on its own. */
const READ = `(() => {
	const rows = [...document.querySelectorAll("main [data-ly-thinking], main .group\\\\/run")];
	const think = document.querySelectorAll("main [data-ly-thinking]");
	return {
		rows: rows.map((r) => (r.matches("[data-ly-thinking]") ? "思考" : "工具")).join(" "),
		thinking: think.length,
		typed: [...think].map((t) => (t.querySelector(".ly-think-runs")?.textContent ?? "").length),
		tools: document.querySelectorAll("main .group\\\\/run").length,
	};
})()`;

/**
 * How many characters each thinking line has put on screen, recorded once per painted frame.
 *
 * The video shows the pacing; this measures it. Sampling on a timer would miss the frames where
 * nothing was painted and count ones that were never shown, and the claim being checked here is
 * exactly "a burst of four hundred characters does not land in a single frame".
 */
const TAP = [
	"(() => {",
	"  window.__typing = [];",
	"  const tick = () => {",
	// The line itself, not `.ly-think-runs`: a finished line carries a second copy of its text
	// for the seamless read-back, and counting both makes every finished line read as double.
	'    const lines = [...document.querySelectorAll("main [data-ly-thinking]")];',
	'    const shown = (l) => (l.querySelector(".ly-think-runs") || { textContent: "" }).textContent.length;',
	"    window.__typing.push([Math.round(performance.now()), lines.map(shown)]);",
	"    requestAnimationFrame(tick);",
	"  };",
	"  requestAnimationFrame(tick);",
	"  return true;",
	"})()",
].join("\n");

/** What one line's typing looked like: how long it took, and the worst single frame. */
function analyse(samples: [number, number[]][], at: number): string {
	const track = samples.map(([t, counts]) => [t, counts[at] ?? 0] as const).filter(([, n]) => n > 0);
	if (track.length === 0) return "没有采到";
	const total = track[track.length - 1][1];
	const start = track[0][0];
	const end = (track.find(([, n]) => n >= total) ?? track[track.length - 1])[0];
	let biggest = 0;
	for (let i = 1; i < track.length; i++) biggest = Math.max(biggest, track[i][1] - track[i - 1][1]);
	const ms = Math.max(1, end - start);
	return `${String(total).padStart(3)} 字 / ${String(ms).padStart(5)}ms = ${String(Math.round((total / ms) * 1000)).padStart(3)} 字每秒，单帧最多 ${biggest} 字`;
}

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
	await settle(800);

	const tape = await recorder(app);
	await app.evaluate(TAP);
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, "帮我看看 detailTrend 的匹配逻辑有没有问题");
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	})()`);

	/*
	 * The turn runs itself; wait for the last step to land.
	 *
	 * Counted in rows rather than matched against the answer's wording. The reasoning is on screen
	 * too, and the reasoning talks about the same thing the answer does — so a substring of the
	 * conclusion appeared four steps early and stopped the recording a third of the way in.
	 */
	let done = false;
	let waited = 0;
	for (let i = 0; i < 240 && !done; i++) {
		await settle(500);
		waited = i;
		done = await app.evaluate<boolean>(
			// The turn is over and the last sentence is on screen. Phrased so it holds whatever the
			// grouping does with the reasoning, which is what makes a before/after pair comparable.
			`!document.querySelector("[data-ly-running]") && document.querySelector("main").innerText.includes("改用主键比较")`,
		);
	}
	// Let the last line finish typing itself out.
	await settle(2600);

	/*
	 * The two things the line does under a pointer, demonstrated rather than described.
	 *
	 * Hovering a finished line reads it back at a steady pace; clicking it unfolds the whole text.
	 * Both were already there — what is new is that there is now a line per thought to do it to.
	 */
	const spot = await app.evaluate<{ x: number; y: number } | null>(`(() => {
		const lines = [...document.querySelectorAll("main [data-ly-thinking] button")];
		const line = lines[3];
		if (!line) return null;
		line.scrollIntoView({ block: "center" });
		const box = line.getBoundingClientRect();
		return { x: Math.round(box.x + Math.min(box.width, 220) / 2), y: Math.round(box.y + box.height / 2) };
	})()`);
	if (spot) {
		await settle(700);
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
		// Long enough for the read-back to get going: it waits 300ms before it starts.
		await settle(5200);
		await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
		await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
		await settle(3200);
	}

	const state = await app.evaluate<{ rows: string; thinking: number; typed: number[]; tools: number }>(READ);
	const samples = await app.evaluate<[number, number[]][]>("window.__typing");
	const { frames, missed } = await tape.stop();

	process.stdout.write(`\n等了 ${((waited + 1) * 0.5).toFixed(1)} 秒收尾\n转录的行： ${state.rows}\n`);
	process.stdout.write(`思考行 ${state.thinking} 条，工具组 ${state.tools} 组，每条已打出的字数 ${state.typed.join("/")}\n`);
	process.stdout.write(`\n每条思考行是怎么打出来的（第 4 条是一次性到达的那段）：\n`);
	for (let at = 0; at < state.thinking; at++) {
		process.stdout.write(`  ${at + 1}. ${analyse(samples, at)}\n`);
	}
	process.stdout.write(`\n采到 ${samples.length} 个绘制帧，录到 ${frames} 帧（丢 ${missed} 帧），合成中…\n`);
	if (!done) process.stdout.write("⚠️  最后一步没等到，视频可能不完整\n");

	await new Promise<void>((resolve, reject) => {
		const ff = spawn(
			"ffmpeg",
			["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-fps_mode", "vfr", "-vf", "scale=1470:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21", join(OUT, `${process.env.PLUME_TAKE ?? "thinking"}.mp4`)],
			{ cwd: FRAMES, stdio: ["ignore", "ignore", "pipe"] },
		);
		let said = "";
		ff.stderr.on("data", (chunk: Buffer) => (said = (said + chunk.toString()).slice(-2000)));
		ff.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败：${said}`))));
	});
	process.stdout.write(`✓ ${join(OUT, `${process.env.PLUME_TAKE ?? "thinking"}.mp4`)}\n`);
} finally {
	await app.stop();
	await new Promise<void>((resolve) => model.close(() => resolve()));
}
