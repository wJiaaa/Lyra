/**
 * 智能配置规则的远程更新。
 *
 * 规则跟着仓库走：`MODEL_RULES_URL` 就是仓库里那份 `catalog/model-rules.json` 的原始地址，跑一次
 * `pnpm rules:update` 再推上去，已安装的 Lyra 下次同步就拿到了，不必等发版。拉到的内容先整份校验，
 * 比当前生效的新才换上，并缓存到 `~/.lyra/model-rules.json`，下次启动离线也能用。任何一步失败都
 * 保持现有规则不变——打包的那份始终兜底。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installModelRules, parseModelRules } from "./model-rules.ts";
import { lyraHome } from "./session/store.ts";
import { writeFileAtomic } from "./utils/atomic-write.ts";

export const MODEL_RULES_URL = "https://raw.githubusercontent.com/wJiaaa/Lyra/main/packages/core/src/catalog/model-rules.json";

/** 同步间隔。规则变化以天计，一小时一次足够及时，也不会给 GitHub 添负担。 */
export const MODEL_RULES_SYNC_INTERVAL_MS = 60 * 60 * 1000;

function cachePath(): string {
	return join(lyraHome(), "model-rules.json");
}

/** 启动时读上次缓存的远程规则。没有或坏了就当没有。返回是否换上了。 */
export async function loadCachedModelRules(): Promise<boolean> {
	try {
		return installModelRules(parseModelRules(JSON.parse(await readFile(cachePath(), "utf8"))));
	} catch {
		return false;
	}
}

/**
 * 拉一次远程规则。返回是否换上了新规则——调用方据此把设置重新套一遍推荐值。
 *
 * 失败不抛：网络不通、仓库暂时 404、内容不合法，都只是这一轮没更新。
 */
export async function syncModelRules(options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}): Promise<boolean> {
	try {
		const response = await (options.fetch ?? globalThis.fetch)(MODEL_RULES_URL, {
			signal: options.signal ?? AbortSignal.timeout(15_000),
		});
		if (!response.ok) return false;
		const text = await response.text();
		const document = parseModelRules(JSON.parse(text));
		if (!installModelRules(document)) return false;
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFileAtomic(cachePath(), text).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}
