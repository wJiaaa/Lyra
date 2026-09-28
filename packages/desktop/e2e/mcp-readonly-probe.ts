/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 真窗口 + 真模型：MCP 工具的只读提示，和工具结果里的图片。
 *
 * 一台本地 stdio MCP 服务器给两个工具——`peek` 标了 `readOnlyHint`，返回一段文字和一张纯红的图；
 * `poke` 什么都没标。模型用的是 `~/.plume` 里配的默认模型，走它自己的协议。量的是：
 *
 *   - auto 模式下 `peek` 不弹审批卡片，`poke` 弹；ask 模式下 `peek` 照样弹。
 *   - 同一条回复里的两次 `peek` 在服务器端时间上重叠（模型真把它们放进一条回复时才验得到）。
 *   - 工具返回的图片按协议的形状出现在发出去的请求里：Chat Completions 是紧跟工具结果的一条
 *     user 消息里的 `image_url`，Responses 是 `function_call_output.output` 里的 `input_image`。
 *     请求经过一个本地转发代理，代理只记这一个布尔值，不记请求头。模型答出的颜色另外打出来，
 *     那是模型能力的观察，不是 Plume 的断言——一个看不了图的模型会照样编一个颜色。
 *
 * 服务器把每次调用的起止时刻记进 profile 里的一个文件，并发与否以它为准，不看界面动画。
 *
 * 用法：node --experimental-strip-types e2e/mcp-readonly-probe.ts [输出目录]
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const REAL_HOME = join(homedir(), ".plume");
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume工具调用测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

/** The MCP server, written into the profile so the app can spawn it with plain `node`. */
function fixtureSource(log: string): string {
	const sdk = (path: string) => JSON.stringify(pathToFileURL(join(SDK, path)).href);
	return `
import { appendFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { Server } from ${sdk("server/index.js")};
import { StdioServerTransport } from ${sdk("server/stdio.js")};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${sdk("types.js")};

// A 32x32 solid red PNG, built by hand so the fixture needs nothing but node.
function redPng() {
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 3).map((_, i) => (i % 3 === 0 ? 255 : 0))]);
	const raw = Buffer.concat(Array.from({ length: 32 }, () => row));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const server = new Server({ name: "probe", version: "1.0.0" }, { capabilities: { tools: {} } });
const input = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "peek", description: "Look at the probe panel. Returns a short note and a picture of it.", inputSchema: input, annotations: { readOnlyHint: true } },
		{ name: "poke", description: "Press the probe button once.", inputSchema: input },
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const start = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const n = request.params.arguments?.n;
	appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: request.params.name, n, start, end: Date.now() }) + "\\n");
	if (request.params.name === "peek") {
		return { content: [{ type: "text", text: "peek " + n + ": panel captured." }, { type: "image", data: redPng(), mimeType: "image/png" }] };
	}
	return { content: [{ type: "text", text: "poke " + n + ": pressed." }] };
});
await server.connect(new StdioServerTransport());
`;
}

interface Scenario {
	label: string;
	port: number;
	mode: "auto" | "ask";
	/** `providerId/modelId` to run on; the configured default when absent. */
	model?: string;
	/** Only the image question: one `peek`, then the colour. */
	imageOnly?: boolean;
}

/** What the forwarding proxy saw: per request, whether a tool result's image was on the wire. */
interface Wire {
	requests: number;
	toolImage: boolean;
	/** Upstream error bodies, verbatim — the app shortens them, and the wording is the evidence. */
	errors: string[];
}

/**
 * Forward everything to the real upstream, noting only whether a tool result's image went along.
 *
 * Headers are passed through untouched and never recorded; the body is parsed for one boolean.
 */
function forwarder(upstream: string, wire: Wire): Server {
	return createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			wire.requests += 1;
			try {
				const json = JSON.parse(body.toString("utf8"));
				const chat = Array.isArray(json.messages) && json.messages.some((m: { role: string; content: unknown }, i: number, all: { role: string }[]) =>
					m.role === "user" && i > 0 && all[i - 1].role === "tool" && JSON.stringify(m.content).includes('"image_url"'));
				// Responses: inside the result, or — on an endpoint that refused that — in a user message after it.
				const responses = Array.isArray(json.input) && json.input.some((item: { type: string; role?: string; output: unknown; content?: unknown }, i: number, all: { type: string }[]) =>
					(item.type === "function_call_output" && Array.isArray(item.output) && item.output.some((part: { type: string }) => part.type === "input_image")) ||
					(item.role === "user" && i > 0 && all[i - 1].type === "function_call_output" && JSON.stringify(item.content).includes('"input_image"')));
				if (chat || responses) wire.toolImage = true;
			} catch {
				// Not JSON; nothing to note.
			}
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined || key === "host" || key === "content-length" || key === "connection") continue;
				headers.set(key, Array.isArray(value) ? value.join(", ") : value);
			}
			try {
				const reply = await fetch(`${upstream}${(req.url ?? "").replace(/^\/v1(?=\/|$)/, "")}`, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
				const out: Record<string, string> = {};
				reply.headers.forEach((value, key) => {
					if (key !== "content-encoding" && key !== "content-length" && key !== "transfer-encoding" && key !== "connection") out[key] = value;
				});
				res.writeHead(reply.status, out);
				if (reply.status >= 400) {
					const text = await reply.text();
					wire.errors.push(`${reply.status} ${text.slice(0, 600)}`);
					res.end(text);
					return;
				}
				if (reply.body) for await (const chunk of reply.body) res.write(chunk);
				res.end();
			} catch (error) {
				res.writeHead(502);
				res.end(String(error));
			}
		});
	});
}

interface Seeded {
	sessionFile: string;
	callLog: string;
}

async function seed(home: string, scenario: Scenario, sessionId: string, proxyPort: number): Promise<Seeded> {
	const { mode } = scenario;
	await mkdir(home, { recursive: true });
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const dir = join(home, "sessions", projectId);
	await mkdir(dir, { recursive: true });

	const callLog = join(home, "mcp-calls.jsonl");
	const fixture = join(home, "mcp-probe.mjs");
	await writeFile(fixture, fixtureSource(callLog));

	// Real model: the app decrypts its own credentials. Copied as files, never read here.
	for (const file of ["credentials.json", "vault.key"]) {
		await copyFile(join(REAL_HOME, file), join(home, file));
	}
	const real = JSON.parse(await readFile(join(REAL_HOME, "settings.json"), "utf8"));
	const modelId: string = scenario.model ?? real.defaultModelId;
	// The one provider this run talks to goes through the forwarder. Both ends say `/v1`, which the
	// forwarder drops once so the path it appends lands where the real base URL would have put it.
	const providers = real.providers.map((provider: { id: string; baseUrl: string }) =>
		modelId.startsWith(`${provider.id}/`) ? { ...provider, baseUrl: `http://127.0.0.1:${proxyPort}/v1` } : provider);
	const at = Date.now() - 60_000;
	const sessionFile = join(dir, `${sessionId}.jsonl`);
	// A session with nothing in it is not listed, so it opens with one exchange already there.
	// Shaped like a real record: the context estimate reads `usage` off every assistant message.
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message = (seq: number, role: string, text: string) =>
		JSON.stringify({
			seq,
			ts: at + seq * 1000,
			type: "message",
			message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000, ...(role === "assistant" ? { api: "openai-chat-completions", provider: "probe", model: "probe", usage, stopReason: "stop" } : {}) },
		});
	await writeFile(
		sessionFile,
		`${[
			JSON.stringify({
				seq: 1,
				ts: at,
				type: "meta",
				meta: { id: sessionId, title: `MCP 只读提示（${mode}）`, cwd, projectId, projectName: "验收工程", createdAt: at, updatedAt: at, modelId, messageCount: 2, usage, seq: 0 },
			}),
			message(2, "user", "接下来我会让你调用 probe 服务器上的 MCP 工具。"),
			message(3, "assistant", "好的。"),
		].join("\n")}\n`,
	);
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			...real,
			providers,
			defaultModelId: modelId,
			permissionMode: mode,
			projectMemory: false,
			mcpServers: [{ id: "probe", name: "probe", transport: "stdio", command: process.execPath, args: [fixture], enabled: true }],
			projects: [{ id: projectId, path: cwd, name: "验收工程", pinned: true, lastOpenedAt: Date.now() }],
			pinnedSessionIds: [],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
	return { sessionFile, callLog };
}

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${saw ? `  —— ${saw}` : ""}`);
}

async function calls(file: string): Promise<{ tool: string; n: unknown; start: number; end: number }[]> {
	const raw = await readFile(file, "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Assistant messages the session log holds, oldest first. */
async function assistantTurns(file: string): Promise<{ text: string; toolCalls: string[]; error?: string }[]> {
	const raw = await readFile(file, "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((record) => record.type === "message" && record.message?.role === "assistant")
		.map((record) => ({
			text: record.message.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(""),
			toolCalls: record.message.content.filter((c: { type: string }) => c.type === "toolCall").map((c: { name: string }) => c.name),
			error: record.message.errorMessage,
		}));
}

async function run(scenario: Scenario): Promise<void> {
	const settings = JSON.parse(await readFile(join(REAL_HOME, "settings.json"), "utf8"));
	const modelId: string = scenario.model ?? settings.defaultModelId;
	const provider = settings.providers.find((p: { id: string }) => modelId.startsWith(`${p.id}/`));
	console.log(`\n【${scenario.label}】permissionMode = ${scenario.mode}，模型 ${modelId}（${provider.api}）`);
	const wire: Wire = { requests: 0, toolImage: false, errors: [] };
	const proxy = forwarder(provider.baseUrl.replace(/\/$/, ""), wire);
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyPort = (proxy.address() as { port: number }).port;
	const sessionId = randomUUID();
	let seeded: Seeded | undefined;
	const app: RunningApp = await startApp({ port: scenario.port, seed: async (home) => void (seeded = await seed(home, scenario, sessionId, proxyPort)) });
	if (!seeded) throw new Error("seed did not run");
	const { sessionFile, callLog } = seeded;
	const d = driver(app);
	const frames: Frame[] = [];
	const stopRecording = await startRecording(scenario.port, frames);
	const card = () => app.evaluate<boolean>(`Boolean(document.querySelector("[data-approval-card]")?.checkVisibility())`);
	const cardText = () => app.evaluate<string>(`document.querySelector("[data-approval-card]")?.innerText ?? ""`);
	const shot = async (name: string) => {
		const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${scenario.label}_${name}.png`), Buffer.from(data, "base64"));
	};
	/** Wait until the turn ends, watching for an approval card the whole time. */
	const turn = async (ms = 240_000) => {
		const end = Date.now() + ms;
		let sawCard = false;
		let started = false;
		let quiet = 0;
		while (Date.now() < end) {
			if (await card()) return { sawCard: true };
			const running = await app.evaluate<boolean>(`Boolean(document.querySelector('button[aria-label="停止"]'))`);
			if (running) { started = true; quiet = 0; } else if (started && ++quiet > 12) return { sawCard };
			await pause(250);
		}
		throw new Error("这一轮没在时限内结束");
	};

	try {
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1500);
		await d.click(`[data-ly-row="${sessionId}"]`);
		await pause(1500);

		if (scenario.imageOnly) {
			await d.type("调用一次 MCP 工具 peek，参数 n=1，不要调用任何其他工具。拿到结果后，用一个中文词回答：peek 返回的图片是什么颜色？");
			await pause(800);
			await d.submit();
			await turn();
			await pause(1500);
			await shot("1-peek看图");
			const turns = await assistantTurns(sessionFile);
			check(`${provider.api}：工具返回的图片按协议形状发了出去`, wire.toolImage, `代理转发了 ${wire.requests} 个请求`);
			const last = turns.at(-1);
			check("这一轮没有因为图片被拒而失败", !last?.error, last?.error?.slice(0, 160) ?? "");
			console.log(`   ℹ️ 模型的回答（能力观察，不计入断言）：${last?.error ? `请求失败：${last.error.slice(0, 400)}` : (last?.text ?? "").slice(0, 120)}`);
		} else if (scenario.mode === "auto") {
			await d.type("在同一条回复里同时调用两次 MCP 工具 peek，参数分别是 n=1 和 n=2，不要调用任何其他工具。拿到结果后，用一个中文词回答：peek 返回的图片是什么颜色？");
			await pause(800);
			await d.submit();
			const first = await turn();
			await pause(1500);
			await shot("1-peek两次");
			const peeks = (await calls(callLog)).filter((c) => c.tool === "peek");
			check("auto：只读的 peek 没有弹审批卡片", !first.sawCard, first.sawCard ? await cardText() : "");
			check("peek 真的在服务器上执行了", peeks.length >= 1, `执行了 ${peeks.length} 次`);
			const turns = await assistantTurns(sessionFile);
			const together = turns.find((t) => t.toolCalls.filter((name) => name.endsWith("__peek")).length >= 2);
			if (together && peeks.length >= 2) {
				const [a, b] = peeks;
				check("同一条回复里的两次 peek 时间上重叠（并行）", a.start < b.end && b.start < a.end, `peek${a.n} ${a.start}→${a.end}，peek${b.n} ${b.start}→${b.end}`);
			} else {
				console.log(`   ⚠️ 模型没有把两次 peek 放进同一条回复，并行这一条没验到（各回复的调用：${JSON.stringify(turns.map((t) => t.toolCalls))}）`);
			}
			check(`${provider.api}：工具返回的图片按协议形状发了出去`, wire.toolImage, `代理转发了 ${wire.requests} 个请求`);
			const last = turns.at(-1);
			check("这一轮没有因为图片被拒而失败", !last?.error, last?.error?.slice(0, 160) ?? "");
			console.log(`   ℹ️ 模型的回答（能力观察，不计入断言）：${last?.error ? `请求失败：${last.error.slice(0, 400)}` : (last?.text ?? "").slice(0, 120)}`);

			await d.type("现在调用一次 MCP 工具 poke，参数 n=1。");
			await pause(800);
			await d.submit();
			const second = await turn();
			await pause(1200);
			await shot("2-poke弹卡片");
			const text = second.sawCard ? await cardText() : "";
			check("auto：没标只读的 poke 弹了审批卡片", second.sawCard, text.replace(/\s+/g, " ").slice(0, 120));
			if (second.sawCard) {
				await d.markByText("/^允许一次$/", "data-probe-allow");
				await d.click("[data-probe-allow]");
				await turn();
				await pause(1200);
				await shot("3-poke批准后");
				const pokes = (await calls(callLog)).filter((c) => c.tool === "poke");
				check("批准之后 poke 执行了", pokes.length === 1, `执行了 ${pokes.length} 次`);
			}
		} else {
			await d.type("调用一次 MCP 工具 peek，参数 n=9。");
			await pause(800);
			await d.submit();
			const only = await turn();
			await pause(1200);
			await shot("1-peek弹卡片");
			check("ask：只读的 peek 照样弹审批卡片", only.sawCard, only.sawCard ? (await cardText()).replace(/\s+/g, " ").slice(0, 120) : "");
			check("批准之前 peek 没有执行", (await calls(callLog)).length === 0, "");
		}
	} finally {
		for (const error of wire.errors) console.log(`   ⚠️ 上游拒绝：${error}`);
		await stopRecording();
		const passed = checks.filter((c) => c.ok).length;
		await encode(frames, join(OUT_DIR, `${STAMP}_${scenario.label}_${passed}of${checks.length}.mp4`));
		await app.stop();
		proxy.closeAllConnections();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	// `PROBE_ONLY=responses` re-runs just the last scenario, e.g. to try another model on the relay.
	if (process.env.PROBE_ONLY !== "responses") {
		await run({ label: "auto模式", port: 9741, mode: "auto" });
		await run({ label: "ask模式", port: 9742, mode: "ask" });
	}
	// The relay case the Responses change was worried about: an array `output` through a gateway.
	await run({ label: "Responses看图", port: 9743, mode: "auto", model: process.env.PROBE_RESPONSES_MODEL ?? "provider-mte9p5s0/glm-5.3-flash", imageOnly: true });
	const bad = checks.filter((c) => !c.ok);
	console.log(bad.length === 0 ? `\n全部成立（${checks.length} 条）` : `\n${bad.length}/${checks.length} 条不成立`);
	console.log(`录屏与截图：${OUT_DIR}`);
	process.exitCode = bad.length === 0 ? 0 : 1;
}

await main();
