/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Dragging a pane past the edge of the window.
 *
 * Reported from a screen recording: hold a panel by its grip, walk the pointer off the bottom of
 * the window, and the panel vanishes. The layout has already closed over the space it left, so the
 * window shows one pane fewer and nothing at all to say where the missing one went. Letting go put
 * it back — but there was no way to know that while holding it.
 *
 * The pane is `fixed`, positioned against the viewport, and its offset was the raw distance the
 * pointer had travelled. Push that past the viewport and the browser simply clips it away.
 *
 * What has to be true now: the pointer may leave, the pane may not. And the *drop test* must not
 * change — outside the window is still nowhere, and a pane released there still flies home. Those
 * two are easy to conflate and this checks them separately.
 *
 * Run: node --experimental-strip-types e2e/dock-drag-bounds-probe.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const PORT = 9475;
const OUT = join(import.meta.dirname, "..", "..", "..", "test-results", "dock-drag-bounds");
const WINDOW = { width: 1200, height: 820 };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({
	port: PORT,
	seed: async (home) => {
		const root = join(home, "project");
		await mkdir(root, { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ ...WINDOW, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: root, name: "project", pinned: false, lastOpenedAt: Date.now() }],
				defaultModelId: null,
				permissionMode: "auto",
				thinking: "medium",
				retryAttempts: 3,
				hooks: [],
				scheduledTasks: [],
				disabledPlugins: [],
				pluginRegistries: [],
				skillRegistries: [],
				alwaysAllow: [],
				sync: { enabled: false, port: 4519, token: null },
				appearance: { theme: "dark" },
			}),
		);
	},
});

const shot = async (name: string) => {
	const result = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, `${name}.png`), Buffer.from(result.data, "base64"));
};

async function press(key: string, code: string, keyCode: number, modifiers: number): Promise<void> {
	const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
	await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
const META = 4;

const down = (x: number, y: number) =>
	app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
const move = (x: number, y: number) =>
	app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
const up = (x: number, y: number) =>
	app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

/** Step there rather than jump, because the dock reads a drag as a sequence. */
async function walk(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
	for (let i = 1; i <= steps; i++) {
		await move(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
		await pause(22);
	}
}

/*
 * Where the carried pane is, in viewport coordinates, and whether the viewport contains it.
 *
 * No backticks: this is interpolated into a template literal on the way to the debugger.
 */
const CARRIED = `(() => {
	const el = document.querySelector('.ly-dock-pane-carried');
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return {
		kind: el.getAttribute('data-dock-pane'),
		left: Math.round(r.left), top: Math.round(r.top),
		right: Math.round(r.right), bottom: Math.round(r.bottom),
		width: Math.round(r.width), height: Math.round(r.height),
		viewport: { width: window.innerWidth, height: window.innerHeight },
		// What the eye actually gets: the part of the card inside the window.
		visible: Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0))
			* Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)),
		area: Math.round(r.width * r.height),
	};
})()`;

interface Carried {
	kind: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
	viewport: { width: number; height: number };
	visible: number;
	area: number;
}

const carried = () => app.evaluate<Carried | null>(CARRIED);

const PANES = `[...document.querySelectorAll('[data-dock-pane]')]
	.filter((el) => el.getAttribute('aria-hidden') !== 'true' && getComputedStyle(el).opacity !== '0'
		&& el.getBoundingClientRect().width > 0)
	.map((el) => el.getAttribute('data-dock-pane')).sort()`;
const panes = () => app.evaluate<string[]>(PANES);

/** The grip of a pane's header, which is the only part of it a drag can pick up. */
const gripOf = (kind: string) =>
	app.evaluate<{ x: number; y: number } | null>(`(() => {
		const el = document.querySelector('[data-dock-pane="${kind}"]');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 10) };
	})()`);

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "  ✔" : "  ✖"} ${what}`);
	if (!ok) failures.push(what);
};

const whole = (c: Carried | null): boolean => Boolean(c && c.visible >= c.area - 4);

try {
	await mkdir(OUT, { recursive: true });
	await pause(2_800);
	await app.evaluate(`(async () => {
		const wait = (ms) => new Promise(r => setTimeout(r, ms));
		const row = document.querySelector('[data-project-row], [data-ly-project]');
		if (row) { row.click(); await wait(1200); }
		return true;
	})()`);
	await pause(1_500);

	console.log("\n[0] 先开两个面板");
	await press("t", "KeyT", 84, META);
	await pause(900);
	await press("j", "KeyJ", 74, META);
	await pause(1_200);
	const before = await panes();
	console.log("    面板:", before.join(", "));

	const grip = await gripOf("browser");
	if (!grip) throw new Error("找不到浏览器面板");

	// ── Pick it up and confirm it follows while the pointer is inside ────────────────────────
	console.log("\n[1] 抓住浏览器面板，先在窗口内拖 —— 应该跟着手走");
	await down(grip.x, grip.y);
	await walk(grip, { x: 500, y: 400 }, 10);
	const inside = await carried();
	console.log("    卡片:", JSON.stringify(inside && { left: inside.left, top: inside.top, w: inside.width, h: inside.height }));
	check(Boolean(inside), "面板确实被拿起来了");
	check(whole(inside), "而且整块都在窗口里");
	await shot("01-inside");

	// ── Off the bottom edge, which is the reported case ──────────────────────────────────────
	console.log(`\n[2] 把指针拖到窗口下方之外（视口高 ${inside?.viewport.height}，指针去 y=1100）`);
	await walk({ x: 500, y: 400 }, { x: 300, y: 1100 }, 14);
	const belowEdge = await carried();
	console.log("    卡片:", JSON.stringify(belowEdge && { left: belowEdge.left, top: belowEdge.top, bottom: belowEdge.bottom, 可见面积: belowEdge.visible, 总面积: belowEdge.area }));
	check(Boolean(belowEdge), "指针在窗口外，面板仍然存在");
	check(whole(belowEdge), "而且整块仍然可见 —— 没有被窗口裁掉");
	check(
		Boolean(belowEdge && belowEdge.bottom <= belowEdge.viewport.height + 1),
		`下边缘停在窗口底边之内（bottom ${belowEdge?.bottom}，视口高 ${belowEdge?.viewport.height}）`,
	);
	await shot("02-below-edge");

	// ── And off the left edge, and the top ───────────────────────────────────────────────────
	console.log("\n[3] 再拖到窗口左边之外，然后上方之外");
	await walk({ x: 300, y: 1100 }, { x: -400, y: 300 }, 14);
	const leftEdge = await carried();
	check(whole(leftEdge), `左边出界时整块仍可见（left ${leftEdge?.left}）`);
	check(Boolean(leftEdge && leftEdge.left >= -1), `左边缘停在 0（left ${leftEdge?.left}）`);

	await walk({ x: -400, y: 300 }, { x: 600, y: -500 }, 14);
	const topEdge = await carried();
	check(whole(topEdge), `上边出界时整块仍可见（top ${topEdge?.top}）`);
	check(Boolean(topEdge && topEdge.top >= -1), `上边缘停在 0（top ${topEdge?.top}）`);
	await shot("03-top-edge");

	// ── Released outside is still nowhere: the pane goes home ────────────────────────────────
	console.log("\n[4] 在窗口外松手 —— 落点判定没变，面板飞回原处");
	await walk({ x: 600, y: -500 }, { x: 900, y: 1200 }, 10);
	await up(900, 1200);
	await pause(1_200);
	await shot("04-released-outside");
	const after = await panes();
	console.log("    面板:", after.join(", "));
	check(
		JSON.stringify(after) === JSON.stringify(before),
		`布局恢复成拖之前的样子（之前 ${before.join(",")} → 现在 ${after.join(",")}）`,
	);
	check((await carried()) === null, "而且没有卡片还留在手里");

	// ── The ordinary drag still works ────────────────────────────────────────────────────────
	console.log("\n[5] 正常拖一次到 dock 左外缘 —— 该落的还是要落");
	/*
	 * The dock's own left edge, not the viewport's.
	 *
	 * The sidebar occupies the first ~270 points, and the drop test is hit against the *dock*: a
	 * pointer at x=8 is over the sidebar, which is outside every landing region, so the pane
	 * correctly flies home. That is the right behaviour and the wrong test for it.
	 */
	const dockLeft = await app.evaluate<number>(`(() => {
		const el = document.querySelector('[data-dock-panes]');
		return el ? Math.round(el.getBoundingClientRect().left) : 0;
	})()`);
	console.log("    dock 左边缘在", dockLeft);
	const grip2 = await gripOf("browser");
	if (grip2) {
		await down(grip2.x, grip2.y);
		await walk(grip2, { x: dockLeft + 8, y: 400 }, 14);
		const atEdge = await carried();
		check(whole(atEdge), "拖到最左边缘时卡片也没被裁");
		await up(dockLeft + 8, 400);
		await pause(1_200);
		await shot("05-docked-left");
		const moved = await app.evaluate<number>(`(() => {
			const el = document.querySelector('[data-dock-pane="browser"]');
			return el ? Math.round(el.getBoundingClientRect().left) : -1;
		})()`);
		console.log("    浏览器现在的左边缘:", moved);
		check(moved >= 0 && moved < dockLeft + 60, `落到了 dock 的最左（left ${moved}，dock 左边缘 ${dockLeft}）`);
	}

	console.log(`\n截图写到 ${OUT}`);
	console.log(failures.length === 0 ? "\n全部通过" : `\n${failures.length} 条没过：\n- ${failures.join("\n- ")}`);
} catch (error) {
	console.error("\n探针自己出错了:", error);
	failures.push(String(error));
} finally {
	await app.stop();
}

if (failures.length > 0) process.exitCode = 1;
