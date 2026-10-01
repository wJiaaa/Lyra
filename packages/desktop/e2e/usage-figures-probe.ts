/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * What the session card reports, on conversations shaped like the ones that prompted the change.
 *
 * The card used to lead with `usage.total`, which counts cache reads alongside fresh input. On a
 * long agentic run those dominate: the real session this is modelled on re-read a 220k context
 * 2,372 times and reported 524.5M beside a 95% hit rate — two figures describing the same fact,
 * the alarming one first. It now reports fresh tokens, and the hit rate is the comment on it.
 *
 * Three shapes, because the change reads differently on each:
 *   relay    — cache reads only, no writes: the case from the report.
 *   anthropic— cache writes *and* reads, which is where the old hit rate was also wrong.
 *   short    — no caching at all, where nothing should move.
 *
 * Run: node --experimental-strip-types e2e/usage-figures-probe.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { seedSessions, type FixtureRecord, type FixtureSession } from "./session-fixture.ts";

const PORT = 9427;
const OUT = join(import.meta.dirname, "..", "..", "..", "test-results", "usage-figures");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Figures taken from the reported session, so what is drawn is what was actually measured. */
const SHAPES = [
	{ id: "relay", title: "https://github.com/Wei-Shaw/sub2api 这个对于 codex 额度太少的问题，是否有解决", replies: 2_372, messages: 4_760, input: 27_800_000, output: 270_000, cacheRead: 496_400_000, cacheWrite: 0 },
	{ id: "anthropic", title: "重构鉴权中间件并补齐回归测试", replies: 120, messages: 260, input: 100_000, output: 50_000, cacheRead: 20_000_000, cacheWrite: 5_000_000 },
	{ id: "short", title: "改一下登录页的间距", replies: 6, messages: 14, input: 50_000, output: 12_000, cacheRead: 0, cacheWrite: 0 },
];

const PROJECT_ID = "aaaaaaaaaaaaaaaa";
let project = "";

const app = await startApp({
	port: PORT,
	seed: async (home) => {
		project = join(home, "demo-project");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "readme.md"), "# demo\n");
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));

		const now = Date.now();
		const sessions: FixtureSession[] = [];
		for (const [index, shape] of SHAPES.entries()) {
			/*
			 * The usage is spread across the replies rather than parked on the meta record.
			 *
			 * `SessionStore.load` re-accumulates from the assistant messages, so a meta figure with no
			 * messages behind it survives only because the fallback keeps it — and the card's own
			 * refresh-on-hover goes through that path. Seeding the messages means the number on screen
			 * was added up by the application, which is the only version worth photographing.
			 */
			const per = {
				input: Math.floor(shape.input / shape.replies),
				output: Math.floor(shape.output / shape.replies),
				cacheRead: Math.floor(shape.cacheRead / shape.replies),
				cacheWrite: Math.floor(shape.cacheWrite / shape.replies),
			};
			const meta = {
				id: shape.id, title: shape.title, cwd: project, projectId: PROJECT_ID, projectName: "demo-project",
				createdAt: now - 86_400_000, updatedAt: now - index * 60_000, modelId: "relay/gemini-3.8-flash-high",
				messageCount: shape.messages,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				seq: 1,
			};
			const records: FixtureRecord[] = [{ seq: 1, ts: now - 86_400_000, type: "meta", meta }];
			let seq = 1;
			// Padded out to the real message count with user turns, so 「消息」 reads as it did.
			const filler = Math.max(0, shape.messages - shape.replies);
			for (let i = 0; i < shape.replies; i++) {
				if (i < filler) {
					records.push({ seq: ++seq, ts: now, type: "message", message: { role: "user", content: [{ type: "text", text: "。" }], timestamp: now } });
				}
				records.push({
					seq: ++seq, ts: now, type: "message",
					message: {
						role: "assistant", content: [{ type: "text", text: "。" }], api: "openai-responses",
						provider: "relay", model: "gemini-3.8-flash-high", stopReason: "stop", timestamp: now,
						usage: { ...per, total: per.input + per.output + per.cacheRead + per.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					},
				});
			}
			for (let i = shape.replies * 2; i < shape.messages; i++) {
				records.push({ seq: ++seq, ts: now, type: "message", message: { role: "user", content: [{ type: "text", text: "。" }], timestamp: now } });
			}
			sessions.push({ meta, records });
		}
		seedSessions(home, sessions);

		await writeFile(join(home, "settings.json"), JSON.stringify({
			version: 1, providers: [], mcpServers: [],
			projects: [{ path: project, name: "demo-project", pinned: false, lastOpenedAt: now }],
			defaultModelId: null, permissionMode: "auto", thinking: "medium", retryAttempts: 3,
			hooks: [], scheduledTasks: [], disabledPlugins: [], pluginRegistries: [], skillRegistries: [],
			alwaysAllow: [], appearance: { theme: "dark" },
		}));
	},
});

const mouseTo = (x: number, y: number) => app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

try {
	await mkdir(OUT, { recursive: true });
	await pause(2_600);

	// The 「聊天」 tab, so every seeded conversation is listed flat rather than under its project.
	const switched = await app.evaluate<boolean>(`(() => {
		const tab = [...document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "聊天");
		if (!tab) return false;
		tab.click();
		return true;
	})()`);
	console.log("切到聊天列表:", switched);
	await pause(900);

	for (const shape of SHAPES) {
		const row = await app.evaluate<{ x: number; y: number } | null>(`(() => {
			const el = document.querySelector('[data-ly-row="${shape.id}"]');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		})()`);
		if (!row) { console.log(`✖ ${shape.id}: 没找到会话行`); continue; }

		const readCard = () => app.evaluate<{ stats: string[]; title: string } | null>(`(() => {
			const el = document.querySelector('[role="tooltip"].ly-glass-solid');
			if (!el) return null;
			return {
				title: (el.querySelector("p")?.textContent || "").trim().slice(0, 30),
				stats: [...el.querySelectorAll(".tabular-nums")].map(n => (n.textContent || "").trim()).filter(Boolean),
			};
		})()`);

		/*
		 * Hover, and give up only after several tries.
		 *
		 * The two large conversations are 4,700-line logs, and hovering asks the main process to
		 * re-read one. The card does not wait for that — it draws from what the list already knows —
		 * but the read competes with the renderer, and a single 1s wait caught the first two rows
		 * mid-load and photographed nothing.
		 */
		let card: { stats: string[]; title: string } | null = null;
		for (let attempt = 0; attempt < 4 && !card; attempt++) {
			// Park the pointer off the list first: re-entering a row the card is already open on is a
			// re-entry, not a new arrival, and skips the delay this is meant to wait out.
			await mouseTo(900, 60);
			await pause(300);
			await mouseTo(row.x, row.y);
			await pause(1_200);
			card = await readCard();
		}
		console.log(`${shape.id}: ${card ? JSON.stringify(card.stats) : "卡片未出现"}`);

		const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT, `${shape.id}.png`), Buffer.from(shot.data, "base64"));
	}

	console.log(`\n截图目录: ${OUT}`);
} finally {
	await app.stop();
}
