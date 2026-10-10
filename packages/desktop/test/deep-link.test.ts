/**
 * `plume://open-session?id=…`：外面来的 URL 里，哪些算数。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { APP_SCHEME, sessionFromUrl } from "../electron/deep-link.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));

test("a session URL names its session", () => {
	assert.equal(sessionFromUrl("plume://open-session?id=5b0c1f2e-8a57-4c1d-9a55-0d6f2f1f6c11"), "5b0c1f2e-8a57-4c1d-9a55-0d6f2f1f6c11");
	// Vibe Island 把变量按查询值编码后填进模板；多出来的参数不碍事。
	assert.equal(sessionFromUrl("plume://open-session?id=abc_123&cwd=%2FUsers%2Ffoo%2Fmy%20project"), "abc_123");
});

test("anything else is not a command", () => {
	for (const url of [
		"",
		"not a url",
		"plume://open-session",
		"plume://open-session?id=",
		"plume://settings?id=abc",
		"https://open-session?id=abc",
		// 拼进 `open-session:<id>` 之后会变成另一条命令的那些。
		"plume://open-session?id=abc:new-session",
		"plume://open-session?id=..%2F..%2Fetc",
		"plume://open-session?id=a%20b",
		`plume://open-session?id=${"a".repeat(65)}`,
	]) {
		assert.equal(sessionFromUrl(url), null, url);
	}
});

/*
 * 处理函数认的 scheme，就是包向系统声明的那个。
 *
 * 两处不一致时没有任何报错：应用照常启动，点卡片照常把窗口带到前台，只是系统从不把 URL 送过来。
 */
test("the packaged app declares the scheme the handler answers", () => {
	const config = parse(readFileSync(join(desktop, "electron-builder.yml"), "utf8")) as { mac: { protocols: { schemes: string[] }[] } };
	assert.deepEqual(config.mac.protocols.map((protocol) => protocol.schemes), [[APP_SCHEME]]);
});
