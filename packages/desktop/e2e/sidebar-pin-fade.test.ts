/**
 * 侧栏钉住的标题盖住从它底下滑过去的会话：不压字、标题底下不空一截、标题自己不淡。
 *
 * 标题铺的是侧栏自己的底色（`misc.css`），会话行不再自己淡出。遮罩只在钉住的标题下沿往下做一段柔化，
 * 那条下沿由 `useStickyFade` 逐帧量出来。这一步停过一次：清理时取消了排着的那一帧却没把记号归零，
 * effect 重跑之后 `schedule` 永远以为「已经排上了」，测量停在第一帧。只有开发构建会重跑（StrictMode），
 * 所以两种构建各走一遍——只跑生产构建的话，这条用例在出事的时候是绿的。
 *
 * 用真滚轮滚：程序改 `scrollTop` 和人滚动走的不是同一条路。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { frames } from "./drive.ts";
import { seedSessions, type FixtureSession } from "./session-fixture.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };

/** 四个项目各五条会话，多到侧栏滚得动、每个项目标题都会钉住一次再被下一个顶走。 */
async function seed(home: string): Promise<void> {
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760, x: 0, y: 0 }));
	const projects = ["甲", "乙", "丙", "丁"].map((name, i) => {
		const path = join(home, `project-${i}`);
		return { path, name, id: createHash("sha256").update(path).digest("hex").slice(0, 16) };
	});
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1, providers: [], mcpServers: [], defaultModelId: null, permissionMode: "auto", thinking: "medium",
			retryAttempts: 3, hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
			projects: projects.map((p, i) => ({ id: p.id, name: p.name, path: p.path, lastOpenedAt: 10 - i })),
			appearance: { theme: "light" },
		}),
	);
	const sessions: FixtureSession[] = [];
	const now = Date.now();
	let n = 0;
	for (const project of projects) {
		await mkdir(project.path, { recursive: true });
		for (let i = 0; i < 5; i++) {
			n++;
			const at = now - n * 3_600_000;
			const meta = {
				id: `pin-${n}`, title: `${project.name}项目的第 ${i + 1} 条会话`, cwd: project.path, projectId: project.id, projectName: project.name,
				createdAt: at, updatedAt: at, modelId: "test", messageCount: 2, usage, seq: 3,
			};
			sessions.push({
				meta,
				records: [
					{ type: "meta", meta },
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "问" }], timestamp: at } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "答" }], api: "anthropic-messages", provider: "test", model: "test", usage, stopReason: "stop", timestamp: at } },
				],
			} as FixtureSession);
		}
	}
	seedSessions(home, sessions);
}

interface Step {
	scrollTop: number;
	/** 此刻钉在顶上的标题有几个。 */
	pinned: number;
	/** 钉住的标题最低的下沿，相对滚动视口。 */
	pinnedBottom: number;
	/** `useStickyFade` 写给遮罩的那条线。测量停了它就停在第一帧的值。 */
	inset: number;
	/** 从钉住的标题底下透出来的行：重叠处最上面的不是标题。 */
	showing: string[];
	/** 紧挨着钉住的标题、却没画全的行——标题底下空出一截。 */
	hidden: string[];
	/** 钉住却没画全的标题，或者底色没铺、和侧栏对不上的标题。 */
	heads: string[];
}

const MEASURE = `(() => {
	const view = document.querySelector(".ly-sidebar-fill .ly-scroll-view");
	const origin = view.getBoundingClientRect().top;
	/* 颜色画到画布上再读回来：计算样式里 rgb()、oklab()、color-mix() 写法各异，按字符串比不了。 */
	const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	const rgba = (css) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = css; paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data].join(","); };
	const pane = rgba(getComputedStyle(view.closest(".ly-nav-column") ?? view.closest(".ly-sidebar-fill")).backgroundColor);
	const heads = [...view.querySelectorAll("[data-ly-head]")]
		.map((head) => ({ head, box: head.getBoundingClientRect() }))
		.filter(({ box }) => box.top - origin < 1 && box.bottom - origin > 0);
	const showing = [];
	const hidden = [];
	const bad = [];
	for (const { head, box } of heads) {
		const name = head.textContent.trim();
		const fill = rgba(getComputedStyle(head).backgroundColor);
		const opacity = parseFloat(getComputedStyle(head).opacity);
		if (fill !== pane || opacity < 0.99) bad.push(name + "（底色 " + fill + "，侧栏 " + pane + "，不透明度 " + opacity + "）");
		const edge = box.bottom - origin;
		for (const row of view.querySelectorAll("[data-ly-row]")) {
			const own = row.getBoundingClientRect();
			const top = Math.max(own.top, box.top, origin);
			const bottom = Math.min(own.bottom, box.bottom);
			if (bottom - top > 2) {
				const hit = document.elementFromPoint(own.left + own.width / 2, (top + bottom) / 2);
				if (!head.contains(hit)) showing.push(name + " 底下透出 " + row.textContent.trim().slice(0, 12));
			}
			const rowTop = own.top - origin;
			const rowOpacity = parseFloat(getComputedStyle(row).opacity);
			if (box.top - origin > -0.5 && rowTop >= edge && rowTop < edge + 30 && rowOpacity < 0.95) {
				hidden.push(name + " 底下的 " + row.textContent.trim().slice(0, 12) + "（不透明度 " + rowOpacity.toFixed(2) + "）");
			}
		}
	}
	return {
		scrollTop: view.scrollTop,
		pinned: heads.length,
		pinnedBottom: heads.reduce((low, { box }) => Math.max(low, box.bottom - origin), 0),
		inset: parseFloat(view.style.getPropertyValue("--ly-fade-inset")) || 0,
		showing,
		hidden,
		heads: bad,
	};
})()`;

/** 指针放在侧栏列表中间，按 `delta` 一格一格地滚，直到滚不动；每格量一次。 */
async function sweep(app: RunningApp, delta: number): Promise<Step[]> {
	const at = await app.evaluate<{ x: number; y: number }>(
		'(() => { const r = document.querySelector(".ly-sidebar-fill .ly-scroll-view").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()',
	);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	const steps: Step[] = [];
	for (let i = 0; i < 80; i++) {
		await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...at, deltaX: 0, deltaY: delta });
		await frames(app, 3);
		const step = await app.evaluate<Step>(MEASURE);
		if (steps.length > 0 && steps[steps.length - 1].scrollTop === step.scrollTop) break;
		steps.push(step);
	}
	return steps;
}

for (const build of ["生产构建", "开发构建"] as const) {
	test(`${build}：侧栏滚动时，钉住的标题盖住底下的会话，不透字、不空一截，遮罩跟着标题走`, async () => {
		const renderer = build === "开发构建" ? await startDevRenderer() : undefined;
		let app: RunningApp | undefined;
		try {
			app = await startApp({ port: build === "开发构建" ? 9892 : 9891, seed, rendererUrl: renderer?.url });
			await app.evaluate('new Promise((r) => { const f = () => document.querySelectorAll(".ly-sidebar-fill [data-ly-row]").length >= 20 ? r() : requestAnimationFrame(f); f(); })');

			const steps = [...(await sweep(app, 12)), ...(await sweep(app, -12))];
			const held = steps.filter((step) => step.pinned > 0);
			assert.ok(held.length >= 10, `滚动中应有标题钉在顶上，实际 ${held.length}/${steps.length} 格`);

			const covered = steps.filter((step) => step.heads.length > 0);
			assert.deepEqual(
				covered.map((step) => `${step.scrollTop}px：${step.heads.join("；")}`),
				[],
				"钉住的标题没铺侧栏的底色，或者自己淡了",
			);

			const through = steps.filter((step) => step.showing.length > 0);
			assert.deepEqual(
				through.map((step) => `${step.scrollTop}px：${step.showing.join("；")}`),
				[],
				"有行从钉住的标题底下透出来",
			);

			const gaps = steps.filter((step) => step.hidden.length > 0);
			assert.deepEqual(
				gaps.map((step) => `${step.scrollTop}px：${step.hidden.join("；")}`),
				[],
				"钉住的标题底下那一行没画全，空出一截",
			);

			// 测量没停：钉住的标题在哪，遮罩的柔化就从哪开始。停了的话它一直是第一帧的值。
			const stale = held.filter((step) => Math.abs(step.inset - step.pinnedBottom) > 1.5);
			assert.deepEqual(
				stale.map((step) => `${step.scrollTop}px：线在 ${step.inset}，标题下沿在 ${step.pinnedBottom.toFixed(1)}`),
				[],
				"渐隐的线没有跟着钉住的标题走",
			);
		} finally {
			await app?.stop();
			await renderer?.close();
		}
	});
}
