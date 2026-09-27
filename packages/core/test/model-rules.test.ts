/**
 * 智能配置：规则按模型、API 格式、站点逐层叠加；手动改过的字段逐项脱离推荐；远程规则只在更新时换上。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	activeModelRules,
	installModelRules,
	parseModelRules,
	resetModelRules,
	resolveModelRules,
	withSmartConfig,
} from "../src/model-rules.ts";
import { loadCachedModelRules, syncModelRules } from "../src/model-rules-sync.ts";
import type { ModelConfig } from "../src/types/provider.ts";

const relay = { baseUrl: "https://relay.example/v1", api: "openai-responses" as const };
const openCodeGo = { baseUrl: "https://opencode.ai/zen/go", api: "openai-chat-completions" as const };
const zhipu = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-chat-completions" as const };

function row(modelId: string, patch: Partial<ModelConfig> = {}): ModelConfig {
	return { id: `p/${modelId}`, providerId: "p", modelId, name: modelId, contextWindow: 1, maxOutputTokens: 1, supportsThinking: false, supportsImages: false, supportsTools: false, ...patch };
}

/** 一份比打包版本新的最小规则文档。 */
function newer(contextWindow: number) {
	const rules = activeModelRules();
	return {
		...rules,
		source: { ...rules.source, updatedAt: new Date(Date.parse(rules.source.updatedAt) + 60_000).toISOString() },
		rules: [{ ...rules.rules[0], config: { ...rules.rules[0].config, contextWindow } }],
	};
}

beforeEach(() => resetModelRules());

test("打包的规则合法，兜底五项齐全", () => {
	const rules = activeModelRules();
	assert.equal(rules.source.license, "Apache-2.0");
	assert.equal(rules.rules[0].model, ".*");
	const { config, specific } = resolveModelRules(relay, "some-private-model-v9");
	assert.equal(specific, false, "只命中兜底，编辑器据此提示「通用默认值」");
	for (const value of Object.values(config)) assert.notEqual(value, undefined);
});

test("同一个型号，站点规则比通用规则更具体", () => {
	const onOpenCode = resolveModelRules(openCodeGo, "glm-5.3");
	const onVendor = resolveModelRules(zhipu, "glm-5.3");
	assert.equal(onOpenCode.specific, true);
	assert.equal(onOpenCode.config.maxOutputTokens, 131_072, "OpenCode Go 的站点规则");
	assert.equal(onVendor.config.maxOutputTokens, 128_000, "没有站点规则时用模型规则");
});

test("Base URL 带不带 /v1、尾斜杠、大小写，命中同一条站点规则", () => {
	for (const baseUrl of ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1", "https://OPENCODE.ai/zen/go/v1/"]) {
		assert.equal(resolveModelRules({ ...openCodeGo, baseUrl }, "glm-5.3").config.maxOutputTokens, 131_072, baseUrl);
	}
	assert.equal(resolveModelRules({ ...openCodeGo, api: "anthropic-messages" }, "glm-5.3").config.maxOutputTokens, 128_000, "站点规则限定了 API 格式");
});

test("智能模式：没覆盖的字段跟随推荐，覆盖了的保留自己的值", () => {
	const recommended = resolveModelRules(openCodeGo, "glm-5.3").config;
	const model = withSmartConfig(openCodeGo, row("glm-5.3", { metadataSource: "smart", contextWindow: 64_000, overrides: ["contextWindow"] }));
	assert.equal(model.contextWindow, 64_000);
	assert.equal(model.maxOutputTokens, 64_000, "跟随推荐的输出上限不能超过手动定的窗口");
	assert.equal(model.supportsTools, recommended.supportsTools);
	assert.deepEqual(withSmartConfig(openCodeGo, model), model, "设置每次读写都会跑，必须幂等");
});

test("手动模式和没有标记的旧模型原样保留；旧的 catalog 标记和旧导入签名转成智能配置", () => {
	const manual = row("glm-5.3", { metadataSource: "manual" });
	assert.deepEqual(withSmartConfig(openCodeGo, manual), manual);
	assert.deepEqual(withSmartConfig(openCodeGo, row("glm-5.3")), row("glm-5.3"));

	const catalog = withSmartConfig(openCodeGo, row("glm-5.3", { metadataSource: "catalog" as never }));
	assert.equal(catalog.metadataSource, "smart");
	assert.equal(catalog.contextWindow, 1_000_000);
	const legacy = withSmartConfig(openCodeGo, row("glm-5.3", { contextWindow: 200_000, maxOutputTokens: 16_384, supportsThinking: true, supportsImages: true, supportsTools: true }));
	assert.equal(legacy.metadataSource, "smart");
});

test("规则校验：不合法的整份拒绝", () => {
	const base = activeModelRules();
	assert.throws(() => parseModelRules({ ...base, schema: 2 }));
	assert.throws(() => parseModelRules({ ...base, rules: [] }));
	assert.throws(() => parseModelRules({ ...base, rules: [{ model: "(", config: {} }] }), "正则编译失败");
	assert.throws(() => parseModelRules({ ...base, rules: [{ ...base.rules[0], config: { contextWindow: -1 } }] }));
	assert.throws(() => parseModelRules({ ...base, rules: [{ ...base.rules[0], config: { ...base.rules[0].config, pdf: true } }] }));
	assert.throws(() => parseModelRules({ ...base, rules: base.rules.slice(1) }), "第一条必须是兜底");
});

test("只换上比当前新的规则", () => {
	assert.equal(installModelRules(parseModelRules(activeModelRules())), false, "同一份不算更新");
	assert.equal(installModelRules(parseModelRules(newer(123_456))), true);
	assert.equal(resolveModelRules(relay, "anything").config.contextWindow, 123_456);
});

let home: string;
let previousHome: string | undefined;
beforeEach(async () => {
	previousHome = process.env.LYRA_HOME;
	home = await mkdtemp(join(tmpdir(), "lyra-rules-"));
	process.env.LYRA_HOME = home;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.LYRA_HOME;
	else process.env.LYRA_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

test("远程同步：拿到更新的规则就换上并缓存，下次启动先读缓存", async () => {
	const body = JSON.stringify(newer(654_321));
	const fetchStub = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;
	assert.equal(await syncModelRules({ fetch: fetchStub }), true);
	assert.equal(resolveModelRules(relay, "anything").config.contextWindow, 654_321);
	assert.equal(await readFile(join(home, "model-rules.json"), "utf8"), body);

	resetModelRules();
	assert.equal(await loadCachedModelRules(), true);
	assert.equal(resolveModelRules(relay, "anything").config.contextWindow, 654_321);
});

test("远程同步：网络失败、非 200、内容不合法、不比当前新，都保持现有规则", async () => {
	const before = activeModelRules();
	const cases: (typeof globalThis.fetch)[] = [
		(async () => { throw new TypeError("offline"); }) as typeof globalThis.fetch,
		(async () => new Response("", { status: 404 })) as typeof globalThis.fetch,
		(async () => new Response("{not json", { status: 200 })) as typeof globalThis.fetch,
		(async () => new Response(JSON.stringify({ ...before, rules: [] }), { status: 200 })) as typeof globalThis.fetch,
		(async () => new Response(JSON.stringify(before), { status: 200 })) as typeof globalThis.fetch,
	];
	for (const fetchStub of cases) assert.equal(await syncModelRules({ fetch: fetchStub }), false);
	assert.equal(activeModelRules(), before);
	assert.equal(await loadCachedModelRules(), false, "没缓存可读");
});
