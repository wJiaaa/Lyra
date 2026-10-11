/* oxlint-disable no-console -- demo CLI that prints what the real window did */
/**
 * 转录里换了模型的那条分隔——在真窗口里打开一段换过三次模型的会话，量位置、读字、拍图、录像。
 *
 * 三次各是一种：第一条回复的服务商已经从设置里删了（名字找不到，得原样写 id）；两轮之间换的
 * （落在那句话上面）；一轮当中才生效的（落在工具那段后面、新回复上面）。
 *
 * 用法：node --experimental-strip-types e2e/model-switch-marker-demo.ts [before|after] [输出目录]
 * `before` 只拍一张图，给改动前的构建用。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume模型切换提示测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION_ID = randomUUID();

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = (providerId: string, modelId: string, name: string) => ({ id: `${providerId}/${modelId}`, providerId, modelId, name, contextWindow: 200000, maxOutputTokens: 8192, supportsImages: false, supportsTools: true, supportsThinking: false });
const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const reply = (provider: string, modelId: string, text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider, model: modelId, usage, stopReason: "stop", timestamp });

const EXPECTED = [
	"模型已切换 legacy/old-model → OpenCode Go (Responses)/gpt-5.6-luna",
	"模型已切换 OpenCode Go (Responses)/gpt-5.6-luna → OpenCode Go (Responses)/deepseek-v4.1-flash",
	"模型已切换 OpenCode Go (Responses)/deepseek-v4.1-flash → Anthropic/Claude Opus 5.5",
];

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const t = Date.now() - 10 * 60_000;
	const messages = [
		user("这个仓库是做什么的？", t),
		reply("legacy", "old-model", "一个 agent 运行时加一个桌面端。", t + 1000),
		user("换个模型，把目录结构讲一遍。", t + 60_000),
		reply("ocgo", "gpt-5.6-luna", "`packages/core` 平台无关，`packages/desktop` 是 Electron。", t + 61_000),
		user("再换个快的，看看测试怎么跑。", t + 120_000),
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "package.json" } }], api: "openai-responses", provider: "ocgo", model: "deepseek-v4.1-flash", usage, stopReason: "toolUse", timestamp: t + 121_000 },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "{}" }], isError: false, timestamp: t + 122_000 },
		reply("anth", "claude-opus-5-5", "单元测试用 `node:test`，跑所在包的 `test:unit`。", t + 123_000),
	];
	const meta = { id: SESSION_ID, title: "换过三次模型", projectId, projectName: "模型切换", cwd, createdAt: t, updatedAt: t + 123_000, modelId: "anth/claude-opus-5-5", messageCount: messages.length, usage, seq: messages.length + 1 };
	seedSessions(home, [{
		meta,
		records: [
			{ type: "meta", meta, seq: 0, ts: t },
			...messages.map((message, i) => ({ type: "message", message, seq: i + 1, ts: message.timestamp })),
			{ type: "meta", meta, seq: meta.seq, ts: t + 123_000 },
		],
	}] as never);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 860 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [
			{ id: "ocgo", name: "OpenCode Go (Responses)", api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKey: "test", enabled: true, models: [model("ocgo", "gpt-5.6-luna", "gpt-5.6-luna"), model("ocgo", "deepseek-v4.1-flash", "deepseek-v4.1-flash")] },
			{ id: "anth", name: "Anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "test", enabled: true, models: [model("anth", "claude-opus-5-5", "Claude Opus 5.5")] },
		],
		defaultModelId: "anth/claude-opus-5-5",
		language: "zh-CN",
		mcpServers: [],
		hooks: [],
		projects: [{ id: projectId, path: cwd, name: "模型切换", pinned: true, lastOpenedAt: t }],
	}));
}

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

async function screenshot(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const frames: Frame[] = [];
	const stop = MODE === "after" ? await startRecording(PORT, frames) : null;
	try {
		await openSession(app, SESSION_ID);
		await until(app, `document.querySelector("[data-ly-transcript-rows]")?.textContent.includes("node:test")`);
		await pause(1200);
		if (MODE === "before") {
			await screenshot("00_改动前_没有任何提示");
			console.log(`改动前截图已写到 ${OUT_DIR}`);
			return;
		}

		const seen = await app.evaluate<{ text: string; next: string; prev: string; lines: number[]; clipped: boolean; color: string }[]>(`[...document.querySelectorAll("[data-ly-model-switch]")].map((row) => {
			const label = row.querySelector(".truncate");
			return {
				text: row.textContent.trim(),
				next: (row.nextElementSibling?.textContent ?? "").trim().slice(0, 30),
				prev: (row.previousElementSibling?.textContent ?? "").trim().slice(0, 30),
				lines: [...row.querySelectorAll("span[aria-hidden]")].map((line) => Math.round(line.getBoundingClientRect().width)),
				clipped: label.scrollWidth > label.clientWidth,
				color: getComputedStyle(row.querySelector("span[aria-hidden]")).backgroundColor,
			};
		})`);
		check("转录里正好三条分隔", seen.length === 3, seen.length);
		for (const [i, want] of EXPECTED.entries()) check(`第 ${i + 1} 条写的是「${want}」`, seen[i]?.text === want, seen[i]?.text);
		check("服务商删掉了的那条照写 id，不空着", seen[0]?.text.includes("legacy/old-model") === true, seen[0]?.text);
		check("两轮之间的切换，落在开新一轮的那句话上面", seen[0]?.next.startsWith("换个模型") === true && seen[1]?.next.startsWith("再换个快的") === true, seen.map((s) => s.next));
		check("一轮当中的切换，落在工具那段后面、新回复上面", seen[2]?.next.startsWith("单元测试用") === true && !seen[2]?.prev.startsWith("再换个快的"), { prev: seen[2]?.prev, next: seen[2]?.next });
		check("两侧横线都画出来了（宽度 > 20px）", seen.every((s) => s.lines.length === 2 && s.lines.every((w) => w > 20)), seen.map((s) => s.lines));
		check("1200 宽的窗口里字没有被截断", seen.every((s) => !s.clipped), seen.map((s) => s.clipped));
		check("横线有颜色，不是透明", seen.every((s) => s.color !== "rgba(0, 0, 0, 0)"), seen[0]?.color);

		await screenshot("01_改动后_三条分隔");
		// 窄的列：字放不下时截断，横线收到最短，不换行。直接把转录那一列压窄——量的是这一行自己的排法。
		const wide = await app.evaluate<number>(`Math.round(document.querySelector("[data-ly-model-switch]").getBoundingClientRect().height)`);
		await app.evaluate(`document.querySelector("[data-ly-transcript-rows]").style.width = "360px"`);
		await pause(800);
		const narrow = await app.evaluate<{ height: number; clipped: boolean }[]>(`[...document.querySelectorAll("[data-ly-model-switch]")].map((row) => ({ height: Math.round(row.getBoundingClientRect().height), clipped: row.querySelector(".truncate").scrollWidth > row.querySelector(".truncate").clientWidth }))`);
		check(`列压到 360px，每条仍是一行高（${wide}px），放不下的字截断`, narrow.every((r) => r.height === wide && r.clipped), { wide, narrow });
		await screenshot("02_改动后_窄列");
		await app.evaluate(`document.querySelector("[data-ly-transcript-rows]").style.width = ""`);
		await pause(800);
	} finally {
		await stop?.();
		await app.stop();
	}
	if (MODE === "after") {
		const passed = checks.filter((c) => c.ok).length;
		const out = join(OUT_DIR, `${STAMP}_转录里的模型切换分隔_${passed}of${checks.length}.mp4`);
		await encode(frames, out, 60, 1200);
		console.log(`\n${passed}/${checks.length} 通过，录像：${out}`);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exit(1);
});
