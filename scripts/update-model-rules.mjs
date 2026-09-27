/**
 * 从本地 ZCode 仓库重新生成智能配置规则 `packages/core/src/catalog/model-rules.json`。
 *
 * 规则源是 ZCode 的内置推荐配置 `config/provider/zcode-builtin.json`（Apache-2.0）。这里只取 Lyra
 * 模型配置用得上的五项：上下文窗口、最大输出、思考、图片输入、工具调用；请求参数映射（`map`）、
 * 模板启用、PDF/音视频等 Lyra 没有对应字段的部分丢掉。层次和组内顺序原样保留——解析时从前往后
 * 逐条叠加，越靠后越具体。
 *
 * 用法：node scripts/update-model-rules.mjs [--zcode <ZCode 仓库路径>]，缺省为 ../ZCode。
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUTPUT = resolve("packages/core/src/catalog/model-rules.json");

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = process.argv[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

const zcode = resolve(argument("--zcode", "../ZCode"));
const builtin = JSON.parse(await readFile(resolve(zcode, "config/provider/zcode-builtin.json"), "utf8"));
const [commit, committedAt] = execFileSync("git", ["-C", zcode, "log", "-1", "--format=%H%n%cI"], { encoding: "utf8" }).trim().split("\n");

function convert(config) {
	const properties = config.properties ?? {};
	const options = config.optionSpecs ?? {};
	const levels = options.reasoningLevel?.values;
	const result = {
		...(typeof properties.contextWindow === "number" ? { contextWindow: properties.contextWindow } : {}),
		...(typeof options.maxOutputTokens?.max === "number" ? { maxOutputTokens: options.maxOutputTokens.max } : {}),
		// ZCode 的档位里 `disabled` / `none` 表示关闭思考；只剩这两个就是不支持。
		...(Array.isArray(levels) ? { supportsThinking: levels.some((level) => level !== "disabled" && level !== "none") } : {}),
		...(typeof properties.inputFormat?.supportsImage === "boolean" ? { supportsImages: properties.inputFormat.supportsImage } : {}),
		...(typeof properties.supportsToolCall === "boolean" ? { supportsTools: properties.supportsToolCall } : {}),
	};
	return Object.keys(result).length > 0 ? result : null;
}

const layers = builtin.config.modelConfigRules;
const rules = [...layers.modelRules, ...layers.modelApiRules, ...layers.providerSiteRules].flatMap((rule) => {
	const config = convert(rule.config);
	if (!config) return [];
	return [{
		model: rule.modelMatch,
		...(rule.apiTypeMatch && rule.apiTypeMatch !== ".*" ? { api: rule.apiTypeMatch } : {}),
		...(rule.baseUrlMatch ? { baseUrl: rule.baseUrlMatch } : {}),
		config,
	}];
});

const snapshot = {
	schema: 1,
	source: {
		name: "ZCode built-in model rules",
		repository: "https://github.com/wJiaaa/ZCode",
		revision: builtin.revision,
		commit,
		updatedAt: committedAt,
		license: "Apache-2.0",
	},
	rules,
};

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
console.log(`Wrote ${rules.length} rules from ZCode ${commit.slice(0, 12)} to ${OUTPUT}`);
