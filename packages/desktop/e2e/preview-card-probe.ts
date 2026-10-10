/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 对话里的预览卡片：怎么展开，套不套对话的样子。
 *
 * 一、比卡片高的页面：折着时停在上限、底部有按钮；真鼠标按下去，卡片长到整页高、读者眼前的位置不动、
 *    侧栏没开；右上角那颗照旧把页面开进侧栏。
 * 二、agent 先把页面写进本会话的 scratch、再用 `path` 发布：它是照工具说明写的（不留外边距），
 *    要跟随主题、不套带框卡片——套了就是内容贴着框边。项目里本来就有的 HTML 照旧是带框的整页。
 * 三、`check` 回给模型的截图是整页（到 2160px），带 `width` 就按那个宽度：一次调用看全，不必另写页面。
 * 四、跟随主题的页面：展开了能从右上角收回；开进侧栏有左右边距；矮的页面多高就多高。
 *
 * 用法：node --experimental-strip-types e2e/preview-card-probe.ts
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, evaluateRenderer, startApp, type RunningApp } from "./app.ts";
import { click, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = join(homedir(), "Desktop", "Plume预览卡片测试");
const PORT = 9497;
const MODEL_PORT = 9597;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const CARD = "main [data-ly-preview]";
const MORE = `${CARD} button[aria-label="展开全部"]`;

/** 四十行、每行 50px：两千多像素，远过 720 的上限。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.row{height:50px;display:flex;align-items:center;border-bottom:1px solid var(--border);color:var(--foreground)}
</style></head><body>${Array.from({ length: 40 }, (_, i) => `<div class="row">第 ${i + 1} 行</div>`).join("")}</body></html>`;

/** 照工具说明写的页面：顶上那一栏左右不留边，和用户报的那一页一样。 */
const DRAFT = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;color:var(--foreground,#111)}.switch{padding:16px 0 12px}h1{font-size:15px;margin:0}
</style></head><body><div class="switch"><h1>宣传页模板 · 4 套方向</h1><p>同一份占位文案，只比风格。</p></div></body></html>`;
const OWN = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"><h1 style="margin:0;padding:24px">项目自己的页面</h1></body></html>`;

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
/** 每句话一份剧本，按这句话之后模型已经回了几次往下走。 */
const SCRIPTS: { when: string; steps: (scratch: string) => Block[][] }[] = [
	{ when: "四十行", steps: () => [[{ tool: "preview", args: { title: "四十行", html: PAGE } }], [{ text: "上面是四十行。" }]] },
	{
		when: "检查",
		steps: () => [
			[{ tool: "preview", args: { title: "四十行", html: PAGE, check: true } }],
			[{ tool: "preview", args: { title: "四十行", html: PAGE, check: true, width: 390 } }],
			[{ text: "看过了。" }],
		],
	},
	{
		when: "草稿",
		steps: (scratch) => [
			[{ tool: "write", args: { path: `${scratch}/index.html`, content: DRAFT } }],
			[{ tool: "preview", args: { title: "草稿页", path: `${scratch}/index.html` } }],
			[{ tool: "write", args: { path: "own.html", content: OWN } }],
			[{ tool: "preview", args: { title: "项目页", path: "own.html" } }],
			[{ text: "两页都在上面。" }],
		],
	},
];

/** 每次检查回给模型的图：PNG 头里读宽高，和同一条结果里的文字。 */
const checks: { width: number; height: number; text: string; png: Buffer }[] = [];
function noteChecks(messages: { role: string; content: unknown }[]): void {
	const last = messages.at(-1);
	if (!last || !Array.isArray(last.content)) return;
	for (const part of last.content as { type: string; content?: { type: string; text?: string; source?: { data: string } }[] }[]) {
		if (part.type !== "tool_result" || !Array.isArray(part.content)) continue;
		const image = part.content.find((item) => item.type === "image")?.source?.data;
		if (!image) continue;
		const png = Buffer.from(image, "base64");
		checks.push({ width: png.readUInt32BE(16), height: png.readUInt32BE(20), text: part.content.map((item) => item.text ?? "").join(""), png });
	}
}

function next(body: string): Block[] {
	const parsed = JSON.parse(body) as { system?: unknown; messages: { role: string; content: unknown }[] };
	noteChecks(parsed.messages);
	const scratch = /Scratch directory: (\S+)/.exec(JSON.stringify(parsed.system ?? ""))?.[1]?.replace(/\\n.*$/, "") ?? "";
	const spoken = (message: { role: string; content: unknown }) =>
		message.role === "user" && Array.isArray(message.content) && message.content.some((part: { type?: string; text?: string }) => part.type === "text" && !part.text?.startsWith("<env>"));
	const at = parsed.messages.findLastIndex(spoken);
	const said = JSON.stringify(parsed.messages[at]?.content ?? "");
	const replies = parsed.messages.slice(at + 1).filter((message) => message.role === "assistant").length;
	const script = SCRIPTS.find((candidate) => said.includes(candidate.when));
	const steps = script ? script.steps(scratch) : [[{ text: "好。" }]];
	return steps[Math.min(replies, steps.length - 1)]!;
}

let request = 0;
function sse(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function startModel(): Server {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const blocks = next(Buffer.concat(chunks).toString("utf8"));
			request++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(300);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } });
				}
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted", autoSummarizeTitle: false, permissionMode: "full", thinking: "off",
		appearance: { theme: "light" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

let passes = 0;
let failures = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
/** 卡片多高、离视口顶多远，按钮在不在，对话那一栏多宽（侧栏一开它就变窄）。 */
const look = (app: RunningApp) => app.evaluate<{ height: number; top: number; more: boolean; column: number }>(`(() => {
	const card = document.querySelector(${JSON.stringify(CARD)});
	const box = card.getBoundingClientRect();
	const more = card.querySelector('button[aria-label="展开全部"]');
	return { height: Math.round(box.height), top: Math.round(box.top), more: Boolean(more && !more.inert), column: Math.round(document.querySelector("main textarea").getBoundingClientRect().width) };
})()`);

await mkdir(OUT_DIR, { recursive: true });
const model = startModel();
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
try {
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	stopRecording = await startRecording(PORT, frames);
	await d.until('document.querySelector("main textarea")', 30000);
	await pause(800);
	await d.type("列四十行给我看");
	await d.submit();
	await d.settled(60000);
	await until(app, `document.querySelector(${JSON.stringify(MORE)})`, 1200);
	await pause(1200);

	console.log("\n一、折着：停在 720，底部有「展开全部」");
	const folded = await look(app);
	check("卡片停在上限 720px，按钮在", folded.height === 720 && folded.more, folded);
	await shot(app, "01_折着");

	console.log("\n二、真鼠标按「展开全部」");
	await click(app, MORE);
	await pause(1200);
	const opened = await look(app);
	await shot(app, "02_展开之后");
	check("卡片长到整页高（四十行 × 50px ≥ 2000px）", opened.height >= 2000, opened);
	check("按钮收起来了", !opened.more, opened);
	check("读者眼前的位置没动（卡片顶漂移 ≤ 2px）", Math.abs(opened.top - folded.top) <= 2, { before: folded.top, after: opened.top });
	check("侧栏没开（对话栏宽度不变）", opened.column === folded.column, { before: folded.column, after: opened.column });

	console.log("\n二之二、右上角收回去");
	// 这一页跟随主题。从前右上角那颗只给带框的卡片，跟随主题的页面展开了就收不回去。
	await click(app, `${CARD} button[aria-label="自适应高度"]`);
	await pause(1200);
	const closed = await look(app);
	await shot(app, "02b_收回之后");
	check("收回到 720，「展开全部」回来", closed.height === 720 && closed.more, closed);

	console.log("\n三、右上角「在侧栏中打开」照旧开侧栏");
	await click(app, `${CARD} button[aria-label="在侧栏中打开"]`);
	await pause(2000);
	const panel = await look(app);
	await shot(app, "03_右上角开侧栏");
	check("对话栏变窄了：侧栏开了", panel.column < opened.column - 100, { before: opened.column, after: panel.column });
	// 侧栏里那一页是自己的顶层文档：左边沿是窗口的，要自己留边距。
	const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { url: string; webSocketDebuggerUrl: string }[];
	const tab = targets.find((target) => target.url.startsWith("ly-preview://"));
	const edge = tab ? await evaluateRenderer<{ padding: string; left: number }>(tab.webSocketDebuggerUrl, `({ padding: getComputedStyle(document.documentElement).paddingLeft, left: Math.round(document.querySelector(".row").getBoundingClientRect().left) })`) : null;
	check("侧栏里的页面左右留了边距（内容离窗口左边 28px）", edge?.padding === "28px" && edge.left === 28, edge ?? targets.map((target) => target.url));

	console.log("\n四、检查的截图：整页，按要的宽度");
	await d.type("检查一下这页");
	await d.submit();
	await d.settled(60000);
	await pause(500);
	const [wide, phone] = checks;
	// 模型拿到的那两张，原样存下来看：尺寸对了不等于画面对了。
	if (wide) await writeFile(join(OUT_DIR, `${STAMP}_检查截图_默认宽.png`), wide.png);
	if (phone) await writeFile(join(OUT_DIR, `${STAMP}_检查截图_390宽.png`), phone.png);
	// 宽高按比例看：截图是设备像素，倍数随屏幕。四十行 × 50px 是 2000px 出头。
	const ratio = (shot: { width: number; height: number } | undefined, width: number) => (shot ? Math.round((shot.height * width) / shot.width) : 0);
	check("默认宽度：截到整页（约 2042px），不是 720", ratio(wide, 720) >= 2000 && ratio(wide, 720) <= 2160, { px: wide && [wide.width, wide.height], css: ratio(wide, 720) });
	check("结果里说截图是整页", /截图是整页：/.test(wide?.text ?? ""), wide?.text.slice(0, 160));
	check("width 390：按 390 宽、整页", ratio(phone, 390) >= 2000 && ratio(phone, 390) <= 2160 && /按 390px 宽检查/.test(phone?.text ?? ""), { px: phone && [phone.width, phone.height], css: ratio(phone, 390) });

	console.log("\n五、scratch 里的草稿跟随主题，项目里的页面照旧带框");
	await d.type("写个草稿页给我看");
	await d.submit();
	await d.settled(60000);
	await until(app, `document.querySelectorAll(${JSON.stringify(CARD)}).length >= 3`, 1200);
	await pause(1200);
	const kinds = await app.evaluate<{ kind: string; border: string; height: number }[]>(`[...document.querySelectorAll(${JSON.stringify(CARD)})].slice(-2).map((card) => ({ kind: card.dataset.lyPreview, border: getComputedStyle(card).borderTopWidth, height: Math.round(card.getBoundingClientRect().height) }))`);
	await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(CARD)})].at(-2).scrollIntoView({ block: "start" })`);
	await pause(800);
	await shot(app, "04_草稿与项目页");
	check("scratch 里的草稿：跟随主题、没有框", kinds[0]?.kind === "themed" && kinds[0].border === "0px", kinds[0]);
	// 两行字的页：从前被撑到 160px，下面空一截，又没有框告诉人页面到哪儿为止。
	check("跟随主题的矮页面多高就多高，不再撑到 160px", (kinds[0]?.height ?? 999) < 140 && (kinds[0]?.height ?? 0) >= 40, kinds[0]);
	check("项目里的页面：照旧是带框的整页", kinds[1]?.kind === "card" && kinds[1].border !== "0px", kinds[1]);
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_预览卡片_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
