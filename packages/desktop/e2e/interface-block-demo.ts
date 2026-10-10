/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里的 ```ui 界面块——在真窗口里边验边录。
 *
 * 假模型把一段带界面块的回复切成小段慢慢流出来，像真模型写的那样。量的是：
 * - 桌面端的系统提示词里有界面块那一段（它跟着 `preview` 工具走）；
 * - 写的时候一块一块长出来，标记原文从不露出来，写完之前整块不能点；
 * - 写完以后统计、图表、选项、滑块、开关、标签页都画出来，表达式跟着状态算；
 * - 「就这个」替人说话：气泡里只有那句话，模型收到的还带着界面里的值；发出去以后按钮写着「已发送」、
 *   按不动，重开还是这样，改一个值它就回来；
 * - 写错的属性（`color`）在下一轮告诉了模型；
 * - 重开窗口，人设过的值还在。
 *
 * 用法：node --experimental-strip-types e2e/interface-block-demo.ts [输出目录]
 *       THEME=dark … 用深色主题再跑一遍，看图表的颜色和卡片的深浅
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, focus, openSession, press, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume界面块测试");
const PORT = 9856;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "interface-block";
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const BLOCK = "main [data-ly-interface]";

/** 模型写的回复。`color` 是故意写错的：它不在 Chart 的属性里，下一轮要告诉模型。 */
const REPLY = `三种方案放在一起看：

\`\`\`ui
<Card title="三种方案" subtitle="按月付的价格">
  <Grid cols={3}>
    <Stat label="基础版" value="¥29/月" hint="5 人以内"/>
    <Stat label="专业版" value="¥99/月" delta="+12%" hint="比上季度"/>
    <Stat label="企业版" value="¥299/月" delta="-3%" hint="比上季度"/>
  </Grid>
  <Tabs>
    <Tab title="用量">
      <Chart kind="bar" data={[{月:"1月",基础:120,专业:80},{月:"2月",基础:132,专业:95},{月:"3月",基础:128,专业:110},{月:"4月",基础:140,专业:131}]} x="月" color="red"/>
    </Tab>
    <Tab title="明细">
      <Table columns={["方案","席位上限","存储"]} rows={[["基础版",5,"10 GB"],["专业版",50,"1 TB"],["企业版",500,"不限"]]}/>
    </Tab>
  </Tabs>
  <Divider/>
  <Choice name="plan" label="方案" options={["基础版","专业版","企业版"]} value="专业版"/>
  <Slider name="seats" label="人数" min={1} max={50} value={5} unit=" 人"/>
  <Toggle name="yearly" label="按年付（八五折）"/>
  <Callout tone="info" title="估算">
    <Text>{plan} · {seats} 人 · 每月约 ¥{round((plan == "基础版" ? 29 : plan == "专业版" ? 99 : 299) * seats * (yearly ? 0.85 : 1))}</Text>
  </Callout>
  <Text tone="muted" when={seats > 20}>超过 20 人建议联系销售。</Text>
  <Button send="就选{plan}，{seats} 人" primary>就这个</Button>
</Card>
\`\`\`

选好了点「就这个」。`;

const requests: { system: string; last: string }[] = [];
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const parsed = JSON.parse(body) as { system?: unknown; messages: { role: string; content: unknown }[] };
			// 跳过日期那条：它是一条只有 `<env>` 的 user 消息，跟在人说的话后面。
			const last = JSON.stringify(parsed.messages.findLast((message) => message.role === "user" && !JSON.stringify(message.content).startsWith('[{"type":"text","text":"<env>'))?.content ?? "");
			requests.push({ system: JSON.stringify(parsed.system ?? ""), last });
			if (last.includes("UI_PLANS")) return void stream(res, REPLY);
			void stream(res, "好，按这个来。");
		});
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function stream(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	// 每段 14 个字、隔 90ms：一千多字的回复写十来秒，看得清它是怎么长出来的。
	for (let at = 0; at < text.length; at += 14) {
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(at, at + 14) } });
		await wait(90);
	}
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "选方案", cwd, projectId, projectName: "界面块", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "我们团队该买哪种方案？" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我先列一下三种方案。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 940, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: THEME, reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "界面块", pinned: true, lastOpenedAt: 1 }],
	}));
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${THEME === "dark" ? "深色_" : ""}${name}.png`), Buffer.from(image.data, "base64"));
};
async function say(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);
/** 界面块里看得见的东西。 */
const look = (app: RunningApp) => app.evaluate<{ state: string; inert: boolean; stats: number; bars: number; estimate: string; pressed: string; slider: string; rawMarkup: boolean; table: number; action: string; actionDisabled: boolean } | null>(`(() => {
	const block = [...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1);
	const reply = block?.closest(".prose-dw");
	if (!block) return { state: "none", inert: false, stats: 0, bars: 0, estimate: "", pressed: "", slider: "", table: 0, action: "", actionDisabled: false, rawMarkup: [...document.querySelectorAll("main pre")].some((pre) => pre.textContent.includes("<Card")) };
	return {
		state: block.dataset.lyInterface,
		inert: block.inert,
		stats: block.querySelectorAll(".text-heading.tabular-nums").length,
		bars: block.querySelectorAll(".ly-ui-chart rect:not([fill='transparent'])").length,
		estimate: [...block.querySelectorAll("p")].map((p) => p.textContent).find((t) => t.includes("每月约")) ?? "",
		pressed: block.querySelector("[data-segmented] [aria-pressed='true']")?.textContent ?? "",
		slider: block.querySelector('input[type="range"]')?.value ?? "",
		table: block.querySelectorAll("tbody tr").length,
		action: (block.querySelector("[data-ly-ui-sent]") ?? [...block.querySelectorAll("button")].at(-1))?.textContent.trim() ?? "",
		// 已发送是一行状态，不是按钮：没有可按的东西就算按不动。
		actionDisabled: Boolean(block.querySelector("[data-ly-ui-sent]")) || Boolean([...block.querySelectorAll("button")].at(-1)?.disabled),
		rawMarkup: [...(reply?.querySelectorAll("pre") ?? [])].some((pre) => pre.textContent.includes("<Card")),
	};
})()`);

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-interface-block-"));
await seed(home, modelAddress.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);

	console.log("\n一、写的时候：一块一块长出来，原文不露，整块不能点");
	await say(app, "UI_PLANS 给我比一比");
	await until(app, `document.querySelector(${JSON.stringify(BLOCK)})`, 1200);
	const samples: NonNullable<Awaited<ReturnType<typeof look>>>[] = [];
	for (let i = 0; i < 80; i++) {
		const now = await look(app);
		if (!now || now.state !== "writing") break;
		samples.push(now);
		if (i === 8) await shot(app, "01_写到一半");
		await wait(150);
	}
	check("系统提示词里有界面块那一段", requests[0]?.system.includes("Interface blocks") === true, requests[0]?.system.length);
	check("写的时候是 writing，整块 inert", samples.length > 3 && samples.every((sample) => sample.inert), samples.length);
	const counts = samples.map((sample) => sample.stats);
	check("统计一个一个长出来，长出来的不再消失", counts.some((n) => n < 3) && counts.includes(3) && counts.every((n, i) => i === 0 || n >= counts[i - 1]!), counts);
	check("标记原文一次也没露出来", samples.every((sample) => !sample.rawMarkup), samples.filter((sample) => sample.rawMarkup).length);

	console.log("\n二、写完：都画出来了，表达式按初值算");
	await idle(app);
	await pause(1000);
	const done = await look(app);
	check("写完变成 ready，可以点了", done?.state === "ready" && !done.inert, done);
	check("三个统计、两组柱子（4 个月 × 2）", done?.stats === 3 && done.bars === 8, { stats: done?.stats, bars: done?.bars });
	check("估算按初值算：专业版 · 5 人 · ¥495", done?.estimate === "专业版 · 5 人 · 每月约 ¥495", done?.estimate);
	await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1).scrollIntoView({ block: "start" })`);
	await pause(600);
	await shot(app, "02_画完");

	console.log("\n三、动一动：选项、滑块、开关、标签页");
	await click(app, `${BLOCK} [data-segmented] button`, "企业版");
	await pause(400);
	await focus(app, `${BLOCK} input[type="range"]`);
	for (let i = 0; i < 3; i++) await press(app, "ArrowRight", 39);
	await click(app, `${BLOCK} button[role="switch"]`);
	await pause(500);
	const moved = await look(app);
	check("选了企业版、8 人、按年付：¥2033", moved?.pressed === "企业版" && moved.slider === "8" && moved.estimate === "企业版 · 8 人 · 每月约 ¥2033", moved);
	await click(app, `${BLOCK} [data-tab]`, "明细");
	await pause(500);
	const tab = await look(app);
	check("切到「明细」，表格三行", tab?.table === 3 && tab.bars === 0, { table: tab?.table, bars: tab?.bars });
	await shot(app, "03_改了选择");

	console.log("\n四、就这个：替人说话，模型拿到值，也拿到写错的地方");
	const before = requests.length;
	await click(app, `${BLOCK} button`, "就这个");
	await until(app, `[...document.querySelectorAll("main .ly-user-bubble")].some((b) => b.textContent.includes("就选企业版，8 人"))`, 900);
	const bubble = await app.evaluate<string>(`[...document.querySelectorAll("main .ly-user-bubble")].at(-1).textContent`);
	check("气泡里只有那句话", bubble.trim() === "就选企业版，8 人", bubble);
	await idle(app);
	const sent = requests[before]?.last ?? "";
	check("模型收到了界面里的值", sent.includes('<interface-values>{\\"plan\\":\\"企业版\\",\\"seats\\":8,\\"yearly\\":true}</interface-values>'), sent.slice(0, 300));
	check("模型被告知 Chart 的 color 没画出来", /<env>.*Chart: has no prop \\"color\\"/.test(sent), sent.slice(sent.indexOf("<env>"), sent.indexOf("<env>") + 200));
	const after = await look(app);
	check("发出去以后按钮写着「已发送」，按不动", after?.action === "已发送" && after.actionDisabled, { action: after?.action, disabled: after?.actionDisabled });
	await app.evaluate(`[...document.querySelectorAll("main .ly-user-bubble")].at(-1).scrollIntoView({ block: "center" })`);
	await pause(800);
	await shot(app, "04_发出去之后");

	console.log("\n五、重开窗口：设过的值还在");
	await app.evaluate("location.reload()");
	await until(app, `document.querySelector('[data-ly-row="${SESSION}"]')`, 1200);
	await openSession(app, SESSION);
	await until(app, `document.querySelector(${JSON.stringify(BLOCK)})`, 1200);
	await pause(800);
	const again = await look(app);
	check("还是企业版、8 人、按年付", again?.pressed === "企业版" && again.slider === "8" && again.estimate === "企业版 · 8 人 · 每月约 ¥2033", again);
	check("重开以后按钮还是「已发送」", again?.action === "已发送" && again.actionDisabled, { action: again?.action, disabled: again?.actionDisabled });
	// 这组标签页没有 name：切到哪页从前只在组件里，重开就回到第一页。
	check("没起名字的标签页也还停在「明细」", again?.table === 3 && again.bars === 0, { table: again?.table, bars: again?.bars });
	// 居中拍：贴在转录底部时它在输入框上方的渐隐里，看不出本来的颜色。
	await app.evaluate(`document.querySelector("main [data-ly-ui-sent]").scrollIntoView({ block: "center" })`);
	await pause(800);
	await shot(app, "05_重开后还在");

	console.log("\n六、改一个值：按钮回来，可以再发");
	await focus(app, `${BLOCK} input[type="range"]`);
	await press(app, "ArrowRight", 39);
	await pause(500);
	const changed = await look(app);
	check("人数改成 9，按钮回到「就这个」、能按", changed?.slider === "9" && changed.action === "就这个" && !changed.actionDisabled, { slider: changed?.slider, action: changed?.action, disabled: changed?.actionDisabled });
	await shot(app, "06_改了值按钮回来");

	console.log("\n七、复制这条回复：块是它画出来的样子，不是标记");
	// 复制写的是系统剪贴板：先存下用户原来的，量完放回去。
	const kept = await app.evaluate<string>("window.plume.clipboard.read()");
	try {
		await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(BLOCK)})].at(-1).closest("[class~='group/msg']").querySelector('button[aria-label="复制这条消息"]').setAttribute("data-probe-copy", "")`);
		await click(app, "button[data-probe-copy]");
		await pause(500);
		const copied = await app.evaluate<string>("window.plume.clipboard.read()");
		check("复制出来是文字：方案、人数是现在的值，表格是 Markdown 表，一个标签都没有", copied.includes("方案: 企业版") && copied.includes("人数: 9 人") && copied.includes("| 方案 | 席位上限 | 存储 |") && !copied.includes("<"), copied);
	} finally {
		await app.evaluate(`window.plume.clipboard.write(${JSON.stringify(kept)})`);
	}
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_界面块${THEME === "dark" ? "_深色" : ""}_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
