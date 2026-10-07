/** Real Electron regression checks with isolated settings and synthetic usage records. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { DEFAULT_SETTINGS, type ModelConfig, type Settings, type Usage } from "@plume/core";
import { startApp, type RunningApp } from "./app.ts";
import { click, type, until } from "./drive.ts";
import { fixtureStore } from "./session-fixture.ts";

let app: RunningApp;
const shots = "/tmp/plume-model-defaults-e2e";
const legacy = (modelId: string): ModelConfig => ({
	id: `relay/${modelId}`, providerId: "relay", modelId, name: modelId,
	contextWindow: 200000, maxOutputTokens: 16384, supportsThinking: true, supportsImages: true, supportsTools: true,
});

before(async () => {
	app = await startApp({ port: 9648, seed: async (home) => {
		await mkdir(join(home, "project"), { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 1100, x: 0, y: 0 }));
		const settings: Settings = {
			...DEFAULT_SETTINGS, uiLocale: "zh-CN", disabledPlugins: ["*"],
			appearance: { ...DEFAULT_SETTINGS.appearance, theme: "light", reduceMotion: "on" },
			providers: [{ id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", api: "openai-responses", apiKey: "", enabled: true,
				models: [legacy("gemini-3.7-flash-high"), legacy("deepseek-v4-flash:0731"), legacy("gemini-pro-agent")] }],
			defaultModelId: "relay/gemini-3.7-flash-high",
			projects: [{ id: "project", name: "目录验证", path: join(home, "project"), pinned: true, lastOpenedAt: 1 }],
		};
		await writeFile(join(home, "settings.json"), JSON.stringify(settings));
		const store = fixtureStore(home);
		await store.recordUsage({ source: "reply", providerId: "relay", modelId: "gpt-5.2-high",
			usage: { input: 1000000, output: 0, cacheRead: 1000000, cacheWrite: 0, total: 2000000, cost: { total: 0 } } as Usage });
		store.close();
	} });
});
after(async () => { await app?.stop(); });
afterEach(async (t) => {
	if (!t.passed && app) {
		await shot("failure");
		t.diagnostic(await app.evaluate<string>("document.body.innerText.slice(-5000)"));
	}
});

async function shot(name: string) {
	await mkdir(shots, { recursive: true });
	const capture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(shots, `${name}.png`), Buffer.from(capture.data, "base64"));
}

async function editor(modelId: string) {
	await click(app, "nav button", "模型设置");
	await until(app, `document.querySelector('[aria-label="编辑模型"]')`, 900);
	await app.evaluate(`(()=>{document.querySelector('[data-edit-qa]')?.removeAttribute('data-edit-qa');const row=[...document.querySelectorAll('[class~="group/row"]')].find(e=>e.textContent.includes(${JSON.stringify(modelId)}));row.querySelector('[aria-label="编辑模型"]').setAttribute('data-edit-qa','');})()`);
	await click(app, "[data-edit-qa]");
	await until(app, `document.querySelector('[data-ly-modal] input')?.value===${JSON.stringify(modelId)}`, 900);
}

const readFields = `(()=>{const modal=document.querySelector('[data-ly-modal]');const read=t=>[...modal.querySelectorAll('label')].find(e=>e.textContent.startsWith(t)).querySelector('input').value;return {id:read('模型 ID'),context:read('上下文窗口'),output:read('最大输出'),input:read('输入价格'),priceOut:read('输出价格'),cache:read('缓存命中价格'),toggles:[...modal.querySelectorAll('[role="switch"]')].map(e=>e.getAttribute('aria-checked')),text:modal.innerText};})()`;

/*
 * 内置智能体七个，见 `core/src/agents-builtin.ts`；加上「会话」那一段里的 `compact`，页面上一共八行。
 */
test("all built-in agents can be configured before any session is created", async (t) => {
	await click(app, "[data-ly-open-settings]");
	await click(app, "nav button", "智能体");
	/*
	 * 等数量不再变，而不是等它等于某个数。
	 *
	 * 智能体名单是异步取回来的，`compact` 那一行不依赖它、先画出来——盯着一个固定数字等，要么
	 * 撞上只有它一个的那一瞬，要么错过。`setInterval` 而不是 `until` 里的 rAF：窗口被别的窗口
	 * 盖住时 rAF 会降频，这个等待就成了看运气。
	 */
	await app.evaluate(`new Promise(resolve=>{let last=-1,same=0;const timer=setInterval(()=>{const n=document.querySelectorAll('[data-agent-profile]').length;same=n===last?same+1:0;last=n;if(n>0&&same>=3){clearInterval(timer);resolve();}},80);setTimeout(()=>{clearInterval(timer);resolve();},10000);})`);
	const visible = await app.evaluate<{ names: string[]; controls: number; overflow: number }>(`({names:[...document.querySelectorAll('[data-agent-profile]')].map(e=>e.getAttribute('data-agent-profile')),controls:document.querySelectorAll('[data-agent-profile] fieldset').length,overflow:document.documentElement.scrollWidth-window.innerWidth})`);
	assert.deepEqual(visible.names, ["general", "explore", "review", "verify", "plan", "simple", "reason", "compact"]);
	/*
	 * 八行，七组 fieldset。
	 *
	 * 前七个是内置智能体，每个带一整组运行配置。`compact` 排在「会话」那一段里，是这次会话的
	 * 压缩模型而不是一个可派活的智能体，控件只有一个模型选择，不套 fieldset——数量对不上不是
	 * 缺了控件，是这一行本来就是另一回事。
	 */
	assert.equal(visible.controls, 7);
	assert.ok(
		await app.evaluate(`Boolean(document.querySelector('[data-agent-profile="compact"] button[aria-label]'))`),
		"compact 那一行也要能选模型，只是控件形状不同",
	);
	assert.equal(visible.overflow, 0);
	await click(app, '[aria-label="explore 模型"]');
	await until(app, `document.querySelector('[data-model="relay/gemini-3.7-flash-high"] button')`, 900);
	await click(app, '[data-model="relay/gemini-3.7-flash-high"] button');
	await until(app, `document.querySelector('[aria-label="explore 模型"]').textContent.includes('gemini-3.7-flash-high')`, 900);
	const saved = await app.evaluate<Settings>("window.plume.settings.get()");
	assert.equal(saved.subAgentProfiles?.explore.modelId, "relay/gemini-3.7-flash-high");
	await click(app, "button", "返回工作区");
	await click(app, "button", "新对话");
	await click(app, "[data-ly-open-settings]");
	await click(app, "nav button", "智能体");
	// 回到这一页，等的还是「名单不再变」——理由同上面那处。
	await app.evaluate(`new Promise(resolve=>{let last=-1,same=0;const timer=setInterval(()=>{const n=document.querySelectorAll('[data-agent-profile]').length;same=n===last?same+1:0;last=n;if(n>0&&same>=3){clearInterval(timer);resolve();}},80);setTimeout(()=>{clearInterval(timer);resolve();},10000);})`);
	assert.equal(await app.evaluate(`document.querySelectorAll('[data-agent-profile]').length`), 8);
	await until(app, `document.querySelector('[aria-label="explore 模型"]').textContent.includes('gemini-3.7-flash-high')`, 900);
	t.diagnostic(JSON.stringify(visible)); await shot("builtin-agents");
});

const suggestion = `[...document.querySelectorAll('[aria-label="模型目录搜索结果"] button')].find(e=>e.textContent.startsWith('按模型 ID 找到'))`;

test("configured models keep their values; the suggested catalogue entry fills them in once", async (t) => {
	await editor("gemini-3.7-flash-high");
	const before = await app.evaluate<{ context: string; output: string; input: string }>(readFields);
	assert.deepEqual({ context: before.context, output: before.output, input: before.input }, { context: "200000", output: "16384", input: "" }, "nothing rewrites a configured model");
	// An unknown relay: the suffix is stripped and Google's own entry is suggested.
	await until(app, `${suggestion}?.textContent.includes('gemini-3.7-flash')`, 900);
	await app.evaluate(`${suggestion}.setAttribute('data-fill-qa','')`);
	await click(app, "[data-fill-qa]");
	const values = await app.evaluate<{ id: string; context: string; output: string; input: string; priceOut: string; cache: string; text: string }>(readFields);
	assert.equal(values.id, "gemini-3.7-flash-high"); assert.equal(values.context, "1048576"); assert.equal(values.output, "65536");
	assert.equal(values.input, "0.75"); assert.equal(values.priceOut, "3.75"); assert.equal(values.cache, "0.075");
	assert.match(values.text, /参考估算/); t.diagnostic(JSON.stringify(values)); await shot("relay-model-prices");
	await click(app, "button", "取消"); await until(app, `!document.querySelector('[data-ly-modal]')`, 900);
	await editor("deepseek-v4-flash:0731");
	await until(app, `${suggestion}?.textContent.includes('deepseek-v4-flash')`, 900);
	await app.evaluate(`${suggestion}.setAttribute('data-fill-qa','')`);
	await click(app, "[data-fill-qa]");
	const images = await app.evaluate<string>(`[...document.querySelectorAll('[data-ly-modal] label')].find(e=>e.textContent.startsWith('支持图片输入')).querySelector('[role="switch"]').getAttribute('aria-checked')`);
	assert.equal(images, "false");
	await app.evaluate(`document.querySelector('[data-ly-modal] [role="switch"]').scrollIntoView({block:'center',behavior:'instant'})`);
	await shot("text-only-capabilities");
	await click(app, "button", "取消"); await until(app, `!document.querySelector('[data-ly-modal]')`, 900);
});

test("an unknown alias has no fake prices and can be filled from a searched entry without rewriting the request id", async () => {
	await editor("gemini-pro-agent");
	const initial = await app.evaluate<{ input: string; text: string }>(readFields);
	assert.equal(initial.input, ""); assert.match(initial.text, /从模型目录填入/);
	assert.equal(await app.evaluate<boolean>(`Boolean(${suggestion})`), false);
	await type(app, '[aria-label="搜索模型目录"]', "google gemini-2.5-pro");
	await until(app, `document.querySelector('[aria-label="模型目录搜索结果"] button')`, 900);
	await app.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="模型目录搜索结果"] button')].find(e=>e.querySelector('span').textContent==='gemini-2.5-pro'&&e.textContent.includes('google'));e.setAttribute('data-bind-qa','');})()`);
	await click(app, "[data-bind-qa]");
	await until(app, `document.querySelector('[data-ly-modal] label input[inputmode="decimal"]')?.value==='1.25'`, 900);
	const fields = await app.evaluate<{ id: string; input: string }>(readFields);
	assert.equal(fields.id, "gemini-pro-agent"); assert.equal(fields.input, "1.25");
	await click(app, "button", "保存"); await until(app, `!document.querySelector('[data-ly-modal]')`, 900);
	const saved = await app.evaluate<Settings>("window.plume.settings.get()");
	const filled = saved.providers[0].models.find((model) => model.modelId === "gemini-pro-agent");
	assert.equal(filled?.pricing?.input, 1.25);
	assert.equal(filled && "catalogRef" in filled, false, "filling in is a one-off, not a link");
});

test("historical relay usage produces a nonzero bill and catalogue coverage", async (t) => {
	await click(app, "nav button", "使用统计");
	await until(app, `document.querySelector('[data-usage-dashboard="true"]')`, 900);
	const visible = await app.evaluate<string>(`document.querySelector('[data-usage-dashboard="true"]').innerText`);
	assert.match(visible, /\$1\.93/); assert.match(visible, /模型目录\s*100\.0%/);
	assert.doesNotMatch(visible, /暂无价格/);
	t.diagnostic(visible); await shot("relay-history-cost");
});
