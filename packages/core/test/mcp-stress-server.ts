/**
 * 一台会各种方式出毛病的 stdio MCP 服务器，给 MCP 加固的测试和压测用。
 *
 * 用 SDK 自己的服务端说话（和 `mcp-http-fixture.ts` 一样不用 zod 的 `McpServer`），要钉住的是
 * 我们的客户端对着一台照规范说话、却慢、会崩、会改工具表的服务器时做得对不对。
 *
 * 由环境变量决定它怎么坏：
 *
 * - `STRESS_DIR`：写 `<pid>.pid`，以及被取消的调用（`cancelled-<n>`），测试据此判断进程和取消。
 * - `STRESS_DELAY`：连上传输之前先等这么多毫秒（启动很慢）。
 * - `STRESS_CRASH`：往 stderr 写几行再 `exit(1)`（启动即崩）。
 * - `STRESS_CRASH_IF_EXISTS`：这个文件存在时同上（先正常起来，之后每次重启都崩）。
 * - `STRESS_TOOLS`：再挂几个只会回声的工具，JSON 数组（超长名、和别的服务器重名）。
 * - `STRESS_ONLY`：只列这几个固定工具，JSON 数组；压测里的「正常小服务器」只要一个 `echo`。
 *
 * 用 `node <本文件>` 起（Node 24 自己会剥类型）。
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const dir = process.env.STRESS_DIR;
if (dir) writeFileSync(join(dir, `${process.pid}.pid`), "");

// 那个文件存在就启动即崩：重连测试先让它正常起来，再放下这个文件，看重连怎么放弃。
const crashIf = process.env.STRESS_CRASH_IF_EXISTS;
if (crashIf && existsSync(crashIf)) process.env.STRESS_CRASH = "the marker file says crash";

if (process.env.STRESS_CRASH) {
	process.stderr.write("starting stress server\n");
	process.stderr.write(`Error: ${process.env.STRESS_CRASH}\n`);
	process.stderr.write("    at boot (stress-server.ts:1:1)\n");
	process.exit(1);
}

type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };

const ANY = { type: "object", properties: {}, additionalProperties: true };
const FIXED: ToolSpec[] = [
	{ name: "echo", description: "Echo back.", inputSchema: ANY },
	{ name: "long", description: "Work for a while, reporting progress.", inputSchema: ANY },
	{ name: "sleep", description: "Wait without saying anything.", inputSchema: ANY },
	{ name: "exit", description: "Exit the process mid-call.", inputSchema: ANY },
	{ name: "change", description: "Add a tool and announce the change.", inputSchema: ANY },
	{ name: "big_text", description: "A very large text.", inputSchema: ANY },
	{ name: "big_image", description: "A large image.", inputSchema: ANY },
	{ name: "small_image", description: "A small image.", inputSchema: ANY },
	{
		name: "structured",
		description: "Structured output.",
		inputSchema: ANY,
		outputSchema: { type: "object", properties: { count: { type: "integer" }, items: { type: "array", items: { type: "string" } } }, required: ["count"] },
	},
	{ name: "links", description: "Resource links and embedded resources.", inputSchema: ANY },
	{ name: "wipe", description: "Delete everything.", inputSchema: ANY, annotations: { destructiveHint: true } },
	{ name: "peek", description: "Read something.", inputSchema: ANY, annotations: { readOnlyHint: true } },
	{ name: "liar", description: "Says read-only and destructive at once.", inputSchema: ANY, annotations: { readOnlyHint: true, destructiveHint: true } },
];
const only = process.env.STRESS_ONLY ? (JSON.parse(process.env.STRESS_ONLY) as string[]) : null;
const extra = process.env.STRESS_TOOLS ? (JSON.parse(process.env.STRESS_TOOLS) as string[]) : [];
let tools: ToolSpec[] = [
	...FIXED.filter((tool) => !only || only.includes(tool.name)),
	...extra.map((name) => ({ name, description: `Echo as ${name}.`, inputSchema: ANY })),
];

const server = new Server({ name: "stress", version: "0.0.0" }, { capabilities: { tools: { listChanged: true }, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: "stress://notes/1", name: "Note one" }] }));
server.setRequestHandler(ReadResourceRequestSchema, (request) => ({ contents: [{ uri: request.params.uri, text: `contents of ${request.params.uri}` }] }));

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("cancelled"));
		});
	});

let calls = 0;
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
	const args = (request.params.arguments ?? {}) as Record<string, number | string | undefined>;
	const call = ++calls;
	extra.signal.addEventListener("abort", () => {
		if (dir) appendFileSync(join(dir, `cancelled-${request.params.name}`), `${call}\n`);
	});
	switch (request.params.name) {
		case "long": {
			const steps = Number(args.steps ?? 5);
			const interval = Number(args.interval ?? 100);
			const token = request.params._meta?.progressToken;
			for (let step = 1; step <= steps; step++) {
				await wait(interval, extra.signal);
				if (token !== undefined) {
					await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, total: steps, message: `step ${step}` } });
				}
			}
			return { content: [{ type: "text", text: `done after ${steps} steps` }] };
		}
		case "sleep":
			await wait(Number(args.ms ?? 1000), extra.signal);
			return { content: [{ type: "text", text: "slept" }] };
		case "exit":
			process.stderr.write("fatal: the stress server was told to exit\n");
			setTimeout(() => process.exit(3), 10);
			return await new Promise(() => {});
		case "change":
			tools = [...tools.filter((tool) => tool.name !== "added"), { name: "added", description: "Arrived later.", inputSchema: ANY }];
			await server.sendToolListChanged();
			return { content: [{ type: "text", text: "changed" }] };
		case "big_text": {
			const size = Number(args.chars ?? 500_000);
			const body = Array.from({ length: Math.ceil(size / 10) }, (_, index) => String(index).padStart(9, "0") + "\n").join("");
			return { content: [{ type: "text", text: `HEAD-MARK\n${body.slice(0, size)}\nTAIL-MARK` }] };
		}
		case "big_image":
		case "small_image": {
			const bytes = request.params.name === "big_image" ? Number(args.bytes ?? 600 * 1024) : 2048;
			// `png` 时给一张真能解码的图（真窗口里要看得见），否则只是凑够字节数。
			const data = (args.png ? noisePng(Number(args.png)) : Buffer.alloc(bytes, call % 251)).toString("base64");
			return { content: [{ type: "text", text: "here is the picture" }, { type: "image", data, mimeType: "image/png" }] };
		}
		case "structured": {
			const structuredContent = { count: 2, items: ["a", "b"] };
			// 照规范的 SHOULD 同时给一份文本；`plain` 时故意不给，看客户端会不会把数据丢掉。
			const content = args.plain ? [] : [{ type: "text", text: JSON.stringify(structuredContent) }];
			return { content, structuredContent };
		}
		case "links":
			return {
				content: [
					{ type: "resource_link", uri: "stress://notes/1", name: "Note one", description: "The first note", mimeType: "text/plain" },
					{ type: "resource", resource: { uri: "stress://inline.txt", mimeType: "text/plain", text: "embedded text body" } },
					{ type: "resource", resource: { uri: "stress://blob.bin", mimeType: "application/octet-stream", blob: Buffer.alloc(3000).toString("base64") } },
					{ type: "audio", data: Buffer.alloc(100).toString("base64"), mimeType: "audio/wav" },
				],
			};
		default:
			return { content: [{ type: "text", text: `called ${request.params.name}` }] };
	}
});

/** 一张 size×size 的随机噪点 PNG：噪点压不动，300×300 就有约 270KB，越过内联图片的上限。 */
function noisePng(size: number): Buffer {
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(body.length);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])));
		return Buffer.concat([head, Buffer.from(type), body, tail]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc((size * 3 + 1) * size);
	for (let index = 0; index < rows.length; index++) rows[index] = index % (size * 3 + 1) === 0 ? 0 : (Math.random() * 256) | 0;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const delay = Number(process.env.STRESS_DELAY ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
await server.connect(new StdioServerTransport());
