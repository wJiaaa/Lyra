/**
 * What actually happens on screen between clicking a commit and seeing its files.
 *
 * `node --experimental-strip-types e2e/git-expand-motion-probe.ts`
 *
 * The report is of a jolt when expanding. `ly-enter` animates opacity and a small rise, neither of
 * which can stutter on its own, so the suspicion is layout rather than animation: the block is
 * rendered once at the height of a three-row skeleton and again at the height of the real diff,
 * and the second is a different order of magnitude. That is not a slow animation, it is two
 * animations of the same element to two different sizes, and the eye reads the switch as a jerk.
 *
 * So this samples height per frame rather than asserting an end state — the end state was already
 * correct while the way it got there was not. A long frame is recorded too: a jolt can equally be
 * the main thread blocking while several hundred diff rows mount.
 */

import { join } from "node:path";
import { startApp } from "./app.ts";

// This checkout: e2e → desktop → packages → root.
const REPO = join(import.meta.dirname, "..", "..", "..");
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}

const app = await startApp({
	port: 9507,
	async seed(home) {
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1360, height: 940, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ id: "e2e", name: "Plume", path: REPO, pinned: true, lastOpenedAt: 1 }],
				defaultModelId: null,
				permissionMode: "auto",
				thinking: "medium",
				retryAttempts: 3,
				hooks: [],
				scheduledTasks: [],
				disabledPlugins: [],
				alwaysAllow: [],
				appearance: { theme: "dark" },
			}),
		);
	},
});

interface Motion {
	note: string;
	/** Distinct heights the block was laid out at, with the ms at which each appeared. */
	steps: { h: number; t: number }[];
	/** The longest single frame during the expansion, in ms. */
	longestFrame: number;
	/** Frames sampled. */
	frames: number;
	/** Frames that missed a whole 60fps refresh (>28ms), which is what a dropped frame is. */
	dropped: number;
	/** Every overrunning frame's duration, so a single spike is distinguishable from a slog. */
	slow: number[];
}

try {
	await settle(2600);

	const ready = await app.evaluate<string>(
		"(async () => {" +
			"const wait = (ms) => new Promise((r) => setTimeout(r, ms));" +
			'document.querySelector("button[data-ly-tip^=Git]")?.click();' +
			"await wait(1800);" +
			"const pane = document.querySelector('[data-pane=\"review\"]');" +
			'if (!pane) return "Git 面板没开";' +
			'const row = [...pane.querySelectorAll("div")].find((d) => d.children.length === 4 && [...d.children].every((c) => c.tagName === "BUTTON"));' +
			'if (!row) return "找不到视图标签行";' +
			"row.children[1].click();" +
			"await wait(2600);" +
			'return "就绪";' +
			"})()",
	);
	check("进入历史视图", ready === "就绪", ready);

	const motion = await app.evaluate<Motion>(
		"(async () => {" +
			"const wait = (ms) => new Promise((r) => setTimeout(r, ms));" +
			"const pane = document.querySelector('[data-pane=\"review\"]');" +
			'if (!pane) return { note: "没有面板", steps: [], longestFrame: 0, frames: 0, dropped: 0, slow: [] };' +
			'const rows = [...pane.querySelectorAll("button")].filter((b) => b.offsetHeight === 46);' +
			'if (!rows.length) return { note: "没有提交行", steps: [], longestFrame: 0, frames: 0, dropped: 0, slow: [] };' +
			// The block belonging to this commit is the sibling that appears right after its row.
			"const host = rows[0].parentElement.parentElement;" +
			"const steps = [];" +
			"let longest = 0;" +
			"let frames = 0;" +
			"let dropped = 0;" +
			"const slow = [];" +
			"let last = performance.now();" +
			"const t0 = performance.now();" +
			"let stop = false;" +
			"const sample = () => {" +
			"  const now = performance.now();" +
			"  const dt = now - last;" +
			"  if (frames > 0 && dt > longest) longest = dt;" +
"  if (frames > 0 && dt > 28) { dropped++; if (slow.length < 12) slow.push(Math.round(dt)); }" +
			"  last = now;" +
			"  frames++;" +
			// The expansion is the second child of the commit's wrapper; absent until it opens.
			"  const block = host.children[1];" +
			"  const h = block ? Math.round(block.getBoundingClientRect().height) : 0;" +
			"  if (steps.length === 0 || steps[steps.length - 1].h !== h) steps.push({ h, t: Math.round(now - t0) });" +
			"  if (!stop) requestAnimationFrame(sample);" +
			"};" +
			"requestAnimationFrame(sample);" +
			"rows[0].click();" +
			"await wait(3000);" +
			"stop = true;" +
			'return { note: "采样完成", steps, longestFrame: Math.round(longest), frames, dropped, slow };' +
			"})()",
	);

	process.stdout.write(`\n── 展开过程逐帧 ──\n  ${motion.frames} 帧，高度序列：${motion.steps.map((s) => s.h + "px@" + s.t + "ms").join(" → ")}\n  最长一帧 ${motion.longestFrame}ms\n\n`);

	/*
	 * How many sizes the block was laid out at.
	 *
	 * Zero (closed) and the final height are unavoidable. Anything in between is a size the block
	 * was shown at and then abandoned, which is the jolt: the skeleton's height, then the diff's.
	 */
	const settled = motion.steps[motion.steps.length - 1]?.h ?? 0;
	const intermediate = motion.steps.filter((s) => s.h > 0 && s.h !== settled);
	check(
		"展开只落在一个高度上，没有中途跳一次再跳一次",
		intermediate.length === 0,
		intermediate.length === 0
			? `直接到 ${settled}px`
			: `中途停在 ${intermediate.map((s) => s.h + "px").join("、")}，最后才到 ${settled}px（骨架停留 ${(motion.steps.find((s) => s.h === settled)?.t ?? 0) - (intermediate[0]?.t ?? 0)}ms）`,
	);
	/*
	 * 60fps means a frame every 16.7ms, so the question is how many frames missed that.
	 *
	 * Judged on the count rather than only the maximum: one 40ms frame is a hitch the eye may not
	 * catch, while thirty 20ms frames is the whole expansion running at half rate and reads as the
	 * drag being described. Both are reported; both have to be clean.
	 */
	check(
		"整个展开过程跑满 60fps，没有掉帧",
		motion.dropped === 0,
		motion.dropped === 0
			? `${motion.frames} 帧无一超时，最长 ${motion.longestFrame}ms`
			: `${motion.dropped}/${motion.frames} 帧掉帧：${motion.slow.join("、")}ms（最长 ${motion.longestFrame}ms）`,
	);
} finally {
	await app.stop();
}

process.exit(failures === 0 ? 0 : 1);
