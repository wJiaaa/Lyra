/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 「消息来自 @谁」那一行和上一行之间的空白，在三种位置上量一遍、各拍一张。
 *
 *   回合结尾之后：后台结果叫醒了会话，上一轮收尾那句话底下有一排悬停才显示的操作，它占着位置；
 *   一轮中间、上面是工具：结果在主智能体干活时到达（`steered`），没有那排操作；
 *   一轮中间、上面是说完的一句：那句话说完时结果正好到了，被插进这一轮。
 *
 * 三处题注到上一行可见内容的距离应当一样，题注到它引出的那段话的距离也一样。第三种那句话悬停时
 * 要有时间和复制：它让出来的空白里得真有东西。
 *
 * 用法：PLUME_E2E_ARTIFACTS=<目录> node --experimental-strip-types e2e/delivery-caption-gap-probe.ts <标签>
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { hover, openSession, shot, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "probe";
const ID = "qa-delivery-gap";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const said = (text: string, timestamp: number, stopReason: "stop" | "toolUse" = "stop", calls: { id: string; path: string }[] = []) => ({
	role: "assistant",
	content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call.id, name: "read", arguments: { path: call.path } }))],
	// 这条回复自己用了 1.5 秒：一轮中间说完的那句，页脚说的是这个数，不是这一轮到它为止的 3 秒。
	api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason, timestamp, durationMs: 1500,
});
const report = (id: string, description: string, timestamp: number, steered = false) => ({
	role: "user", synthetic: true, ...(steered ? { steered: true } : {}),
	content: [{ type: "text", text: `<report>${description}</report>` }],
	delivery: [{ id, agent: "review", description, status: "done" }],
	timestamp,
});
const read = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "# QA fixture\n" }], isError: false, timestamp });

let failed = 0;
function check(what: string, ok: boolean, saw: string) {
	if (!ok) failed++;
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

const app = await startApp({
	port: 9671,
	seed: async (home) => {
		const cwd = join(home, "project");
		await mkdir(cwd);
		const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		const messages = [
			{ role: "user", content: [{ type: "text", text: "分头查一下登录和任务写入两处的竞态。" }], timestamp: 1000 },
			said("派出去了两路，回来一路说一段。", 2000),
			// 叫醒会话的送达：上一轮收尾那句话底下有操作行。
			report("sub-a", "反证身份回读竞态", 3000),
			said("独立复核确认，迟到的用户信息响应确实可能覆盖新登录用户的前端身份快照。", 4000),
			report("sub-b", "评估 API 重构方向", 5000),
			said("先看一眼说明再接着说。", 6000, "toolUse", [{ id: "call-1", path: "README.md" }]),
			read("call-1", 6500),
			// 一轮中间到达的送达：上面是一行工具。
			report("sub-c", "反证任务会话竞态", 7000, true),
			said("任务写入的反证结论一致：跨账号的迟到响应是既有风险，不是这轮引入的回归。", 8000),
			// 一轮中间到达的送达：上面是一句说完的话。
			report("sub-d", "反证代理凭据泄露链", 9000, true),
			said("代理凭据那条链核实过了：新签发的 Session 不会经头像删除接口回到沙箱。", 10000),
		];
		const meta = { id: ID, title: "题注间距", projectId, projectName: "间距验证", cwd, createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: messages.length, usage, seq: messages.length + 1 };
		// oxlint-disable-next-line typescript/no-explicit-any -- fixture 写的就是日志里的原样记录，类型由 seedSessions 那边校验
		seedSessions(home, [{ meta, records: [{ type: "meta", meta, ts: 1 }, ...messages.map((message: any) => ({ type: "message" as const, message, ts: 1 })), { type: "meta", meta, ts: 2 }] }]);
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1000, height: 900 }));
		await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [], mcpServers: [], hooks: [], projects: [{ id: projectId, path: cwd, name: "间距验证", pinned: true, lastOpenedAt: 1 }] }));
	},
});

try {
	await until(app, `document.querySelector('[data-ly-row="${ID}"]')`, 20_000);
	await openSession(app, ID);
	await until(app, `document.querySelectorAll('[data-delivery-kind="agent"]').length === 4`, 10_000);
	// 鼠标挪到转录外面：操作行只在悬停时显示，量的是平时的样子。
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
	/*
	 * 每一行题注：它上面最近一行**看得见**的东西的下沿到题注上沿，题注下沿到它引出的那段话上沿。
	 * 「看得见」按 opacity 算：那排悬停才显示的操作占着位置，但人看到的是它上面那句话。
	 */
	const gaps = await app.evaluate<{ what: string; above: number; below: number }[]>(`(() => {
		const visible = (el) => { for (let n = el; n; n = n.parentElement) if (getComputedStyle(n).opacity === "0") return false; return true; };
		const leaves = [...document.querySelectorAll('[data-ly-transcript-rows] .ly-flow-row, [data-ly-transcript-rows] .prose-dw > *, [data-ly-transcript-rows] [data-ly-hover-reveal]')].filter(visible);
		return [...document.querySelectorAll('[data-delivery-kind="agent"]')].map((row) => {
			const box = row.getBoundingClientRect();
			const before = leaves.filter((el) => !row.contains(el) && el.getBoundingClientRect().bottom <= box.top + 0.5).pop();
			const after = leaves.find((el) => !row.contains(el) && el.getBoundingClientRect().top >= box.bottom - 0.5);
			return { what: row.textContent.trim(), above: Math.round(box.top - before.getBoundingClientRect().bottom), below: Math.round(after.getBoundingClientRect().top - box.bottom) };
		});
	})()`);
	for (const gap of gaps) console.log(`   ${gap.what}：上 ${gap.above}px，下 ${gap.below}px`);
	const aboves = new Set(gaps.map((gap) => gap.above));
	const belows = new Set(gaps.map((gap) => gap.below));
	check("四行题注到上一行可见内容的距离一样", aboves.size === 1, [...aboves].join(" / "));
	check("四行题注到下面那段话的距离一样", belows.size === 1, [...belows].join(" / "));
	await shot(app, `${LABEL}_题注间距`);

	const PAUSED = "任务写入的反证结论一致";
	await hover(app, '[data-ly-quote="assistant"] .prose-dw p', PAUSED, "starts");
	await new Promise((resolve) => setTimeout(resolve, 400));
	const actions = await app.evaluate<string | null>(`(() => {
		const reply = [...document.querySelectorAll('[data-ly-quote="assistant"]')].find((el) => el.textContent.startsWith(${JSON.stringify(PAUSED)}));
		const row = reply && [...reply.children].find((el) => el.hasAttribute("data-ly-hover-reveal"));
		return row && getComputedStyle(row).opacity === "1" ? row.textContent.trim() : null;
	})()`);
	check("插进结果之前说完的那句，悬停有时间和复制", actions !== null, actions ?? "没有那一行");
	check("它的耗时是它自己的 1.5 秒，不是整轮到它为止的", actions?.includes("1.5s") === true && !actions.includes("3.0s"), actions ?? "");
	await shot(app, `${LABEL}_悬停说完的那句`);
} finally {
	await app.stop();
}
process.exit(failed > 0 ? 1 : 0);
