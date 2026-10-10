/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里的 ```ui 块在手机上画成什么样。
 *
 * 走真的那条路：桌面开手机访问，同一个窗口切成 390 宽去开 `mobile/dist`，直连、新建会话、发一句话，
 * 假模型回一段带界面块的回复。量的是手机页面上看得到的东西：源码不在、数字在、网格两列并排、图表
 * 几根条、表格是表、标签页能切、控件只写值并说明要回电脑上操作。
 *
 * 先 `pnpm --filter @plume/mobile build:web` 和桌面端 `pnpm build`。
 * 用法：node --experimental-strip-types e2e/mobile-interface-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { click, frames, openSettings, type, until } from "./drive.ts";
import { questionModel } from "./mention-question-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume手机界面块测试");
const PORT = 9394;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PROMPT = "MOBILE_UI";

const REPLY = `这周的数：

\`\`\`ui
<Card title="本周概况" subtitle="10 月 4 日 – 10 日">
  <Grid cols={3}>
    <Stat label="访问" value="12,480" delta="+8%"/>
    <Stat label="转化" value="3.1%" delta="-0.4%"/>
    <Stat label="退款" value="6" hint="都已处理"/>
  </Grid>
  <Progress label="季度目标" value={68}/>
  <Chart kind="bar" data={[{day:"周一",v:120},{day:"周二",v:180},{day:"周三",v:90},{day:"周四",v:210}]} unit="单"/>
  <Tabs>
    <Tab title="渠道"><Table columns={["渠道","占比"]} rows={[["搜索",42],["直接",31],["社交",27]]}/></Tab>
    <Tab title="备注"><Callout tone="warning" title="周三">支付通道维护了两小时。</Callout></Tab>
  </Tabs>
  <Choice name="range" label="下周看" options={["按天","按周"]} value="按天"/>
  <Button send="按这个范围再出一份" primary>再出一份</Button>
</Card>
\`\`\`

有要细看的告诉我。`;

function stream(res: ServerResponse, text: string) {
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	emit("message_start", { message: { id: "mobile-ui", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown) {
	results.push({ name, ok, detail: JSON.stringify(detail) });
	console.log(`${ok ? "✅" : "❌"} ${name}  ${JSON.stringify(detail)}`);
}

await mkdir(OUT_DIR, { recursive: true });
const model = questionModel((messages, res) => {
	if (!JSON.stringify(messages.slice(-3)).includes(PROMPT)) return false;
	stream(res, REPLY);
	return true;
});
model.server.listen(0, "127.0.0.1"); await once(model.server, "listening");
const modelPort = (model.server.address() as { port: number }).port;
const root = resolve("../mobile/dist");
const web = createServer(async (request, response) => {
	const file = resolve(root, "." + new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/$/, "/index.html"));
	if (!file.startsWith(root + "/")) return void response.writeHead(403).end();
	try {
		const data = await readFile(file);
		response.setHeader("content-type", ({ ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".ttf": "font/ttf" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
		response.end(data);
	} catch { response.writeHead(404).end(); }
});
web.listen(0, "127.0.0.1"); await once(web, "listening");
const webPort = (web.address() as { port: number }).port;

const app = await startApp({ port: PORT, seed: async (home) => {
	const cwd = join(home, "project"); await mkdir(cwd); await writeFile(join(cwd, "README.md"), "# Mobile UI\n");
	const id = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 880 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({ projects: [{ id, name: "Plume", path: cwd }], providers: [{ id: "qa", name: "QA", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test-only-provider-key", enabled: true, models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "Test model", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false, supportsImages: true }] }], defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", appearance: { theme: "dark" } }));
} });
const video: Frame[] = [];
let stopRecording: (() => Promise<void>) | null = null;
const snap = async (name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
const theme = (value: string) => app.evaluate(`window.plume.settings.get().then((s) => window.plume.settings.save({ ...s, appearance: { ...s.appearance, theme: ${JSON.stringify(value)} } }))`);

try {
	// 录像要在离开主界面之前开：认的是画着主界面的那个页面目标。
	stopRecording = await startRecording(PORT, video);
	await openSettings(app, "手机连接");
	await type(app, 'input[aria-label="监听端口"]', "4520");
	await click(app, '[role="switch"][aria-label="允许手机访问"]');
	await until(app, 'Boolean(document.querySelector(\'img[alt="手机配对二维码"]\'))');
	const access = await app.evaluate<{ token: string }>("window.plume.mobile.status()");
	await app.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await app.send("Page.navigate", { url: `http://127.0.0.1:${webPort}` });
	await until(app, 'Boolean(document.querySelector(\'input[aria-label="桌面地址"]\'))');
	await type(app, 'input[aria-label="桌面地址"]', "http://127.0.0.1:4520");
	await type(app, 'input[aria-label="配对令牌"]', access.token);
	await click(app, '[role="button"][aria-label="连接电脑"]');
	await until(app, 'Boolean(document.querySelector(\'[aria-label="新会话"]\'))');
	await click(app, '[role="button"][aria-label="新会话"]');
	await until(app, 'Boolean(document.querySelector(\'[role="button"][aria-label="开始会话"]\'))');
	await click(app, '[role="button"][aria-label="开始会话"]');
	await until(app, 'Boolean(document.querySelector(\'textarea[aria-label="给 Plume 发消息…"]\'))');
	await type(app, 'textarea[aria-label="给 Plume 发消息…"]', PROMPT);
	await click(app, '[role="button"][aria-label="发送消息"]');
	await until(app, 'document.body.innerText.includes("有要细看的告诉我")', 900);
	await frames(app, 30); await pause(1000);

	const page = await app.evaluate<{ text: string; stats: { top: number; left: number }[]; bars: number; tableCells: number; hint: boolean }>(`(() => {
		const text = document.body.innerText;
		const at = (word) => { const node = [...document.querySelectorAll("div")].filter((e) => e.childElementCount === 0 && e.textContent === word)[0]; const r = node?.getBoundingClientRect(); return r ? { top: Math.round(r.top), left: Math.round(r.left) } : null; };
		return {
			text,
			stats: ["12,480", "3.1%", "6"].map(at),
			bars: ["周一", "周二", "周三", "周四"].filter((word) => text.includes(word)).length,
			tableCells: ["搜索", "直接", "社交"].filter((word) => text.includes(word)).length,
			hint: text.includes("按钮和输入要回到电脑上操作"),
		};
	})()`);
	check("源码不再出现在手机上", !page.text.includes("<Grid") && !page.text.includes("<Stat"), page.text.includes("<Grid"));
	check("三个数字都画出来了", page.stats.every(Boolean), page.stats);
	check("网格在 390 宽放两列：前两个数并排，第三个换行", page.stats[0]?.top === page.stats[1]?.top && page.stats[1]!.left > page.stats[0]!.left && page.stats[2]!.top > page.stats[0]!.top, page.stats);
	check("柱状图四根条的标签都在", page.bars === 4, page.bars);
	check("第一个标签页里的表画出来了", page.tableCells === 3, page.tableCells);
	check("选项写出当前值，按钮不画，底下说明回电脑上操作", page.text.includes("下周看") && page.text.includes("按天") && !page.text.includes("再出一份") && page.hint, { hint: page.hint });
	await app.evaluate(`[...document.querySelectorAll("div")].find((e) => e.childElementCount === 0 && e.textContent === "本周概况")?.scrollIntoView({ block: "start" })`);
	await frames(app, 20); await pause(800);
	await snap("01_手机上的界面块_暗色");
	await click(app, '[role="tab"]', "备注");
	await until(app, 'document.body.innerText.includes("支付通道维护了两小时")');
	await frames(app, 20); await pause(800);
	const switched = await app.evaluate<{ note: boolean; table: boolean }>(`({ note: document.body.innerText.includes("支付通道维护了两小时"), table: document.body.innerText.includes("社交") })`);
	check("标签页能切：切到「备注」，表换成提示", switched.note && !switched.table, switched);
	await snap("02_切到备注页");
	await theme("light");
	await until(app, '!matchMedia("(prefers-color-scheme: dark)").matches');
	await frames(app, 20); await pause(800);
	await snap("03_亮色");
	await theme("dark");
	await pause(600);
} finally {
	await stopRecording?.();
	const passed = results.filter((result) => result.ok).length;
	if (video.length > 1) await encode(video, join(OUT_DIR, `${STAMP}_手机界面块_${passed}of${results.length}.mp4`));
	await app.stop();
	await closeListeningServer(web);
	await closeListeningServer(model.server);
	console.log(`\n${passed}/${results.length} 通过 → ${OUT_DIR}`);
	process.exitCode = passed === results.length ? 0 : 1;
}
