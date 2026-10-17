/**
 * magpie 写进 settings.json 的 `magpie` 块：读入时变成一个供应商，写盘时不留痕。
 *
 * 写盘那半边是要紧的：合成的供应商一旦落进 `providers`，它就成了用户自己的——magpie 断开时恢复的
 * 只是 `magpie` 块，这一项会永远留下，key 还被挪进 vault。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { magpieProvider } from "../src/config/magpie.ts";
import { loadSettings, resolveModel, saveSettings } from "../src/config/settings.ts";
import { resetVault } from "../src/config/vault.ts";
import { catalogModelFor, catalogPricing } from "../src/model-catalog.ts";

let home: string;
const made: string[] = [];
const previous = { home: process.env.PLUME_HOME, userProfile: process.env.USERPROFILE };

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-magpie-"));
	made.push(home);
	process.env.PLUME_HOME = home;
	process.env.USERPROFILE = home;
	resetVault();
});

after(async () => {
	if (previous.home === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = previous.home;
	if (previous.userProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previous.userProfile;
	await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

const gateway = {
	baseUrl: "http://127.0.0.1:3425",
	apiKey: "magpie-plume",
	models: [
		{ id: "cliproxyapi/gpt-6-luna", name: "GPT-6 Luna", context: 1_000_000, output: 128_000, images: true, efforts: ["none", "low", "high"] },
		// magpie 不知道档位时给的是 null（Go 的 nil 切片），不是空数组
		{ id: "group/auto-glm", name: "", context: 0, output: 0, images: false, efforts: null },
	],
};

const own = { id: "provider-a", name: "公司", baseUrl: "https://example.invalid", api: "openai-responses", apiKey: "sk-own", enabled: true, models: [] };

test("magpie 断开后留下的空对象、缺 key 的块都算没接", () => {
	assert.equal(magpieProvider(undefined), null);
	assert.equal(magpieProvider({}), null);
	assert.equal(magpieProvider({ baseUrl: gateway.baseUrl, models: gateway.models }), null);
});

test("magpie 的档位名换成 Plume 的，未知的上下文和输出按目录外模型的默认值", () => {
	const [luna, glm] = magpieProvider(gateway)!.models;
	assert.deepEqual(
		luna.thinkingOptions?.map((option) => option.id),
		["off", "low", "high"],
	);
	assert.equal(luna.contextWindow, 1_000_000);
	assert.equal(luna.supportsImages, true);
	// 没给档位不等于不会思考：留给默认四档
	assert.equal(glm.thinkingOptions, undefined);
	assert.equal(glm.supportsThinking, true);
	assert.equal(glm.contextWindow, 200_000);
	assert.equal(glm.supportsImages, false);
	assert.equal(glm.name, "group/auto-glm");
});

test("magpie 不给价格：去掉网关前缀按目录取参考价，路由组匹配不上就不定价", () => {
	const [luna, glm] = magpieProvider(gateway)!.models;
	// 没有价格时每次请求都记成 0 美元，会话卡片只能写「未定价」
	const reference = catalogModelFor({ baseUrl: "" }, "gpt-6-luna");
	assert.ok(reference, "打包的目录里应有 gpt-6-luna");
	assert.deepEqual(luna.pricing, catalogPricing(reference.model));
	assert.equal(luna.pricing?.source, "catalog");
	assert.equal(glm.pricing, undefined);
});

test("读入时多一个 Magpie 供应商，magpie 选的默认模型找得到", async () => {
	await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [own], defaultModelId: "magpie/cliproxyapi/gpt-6-luna", magpie: gateway }));
	const settings = await loadSettings();
	assert.deepEqual(
		settings.providers.map((provider) => provider.id),
		["provider-a", "magpie"],
	);
	const resolved = resolveModel(settings, settings.defaultModelId);
	assert.equal(resolved?.provider.apiKey, "magpie-plume");
	assert.equal(resolved?.model.modelId, "cliproxyapi/gpt-6-luna");
});

test("存盘时 Magpie 供应商不进 providers，magpie 块和它的 key 原样留在文件里", async () => {
	await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [own], magpie: gateway }));
	await saveSettings(await loadSettings());

	const file = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
	assert.deepEqual(
		file.providers.map((provider: { id: string }) => provider.id),
		["provider-a"],
	);
	// magpie 靠这一键还是它给的 key 来判断接着没有
	assert.equal(file.magpie.apiKey, "magpie-plume");
	// 用户自己的 key 照旧进 vault
	assert.equal(file.providers[0].apiKey, "");
	assert.deepEqual(
		(await loadSettings()).providers.map((provider) => [provider.id, provider.apiKey]),
		[
			["provider-a", "sk-own"],
			["magpie", "magpie-plume"],
		],
	);
});
