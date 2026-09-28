/**
 * The things asked for on the appearance page.
 *
 * `node --experimental-strip-types e2e/settings-preview-probe.ts [dir]`
 *
 *   1. 「Plume 默认」 is the default, and it leaves the app's own surface alone — a fresh install
 *      must not repaint itself in somebody else's palette.
 *   3. 代码外观's specimens take typing directly, stay highlighted while they do, and carry one
 *      reset button that does not sit on top of the theme's name.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const dir = process.argv[2] ?? "/tmp/plume-preview";

async function seed(home: string): Promise<void> {
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1320, height: 940, x: 0, y: 0 }));
	/*
	 * No `appearance` key at all, deliberately.
	 *
	 * That is what a fresh install looks like, and the whole of requirement 1 is what the app
	 * does when nobody has chosen anything.
	 */
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
		}),
	);
}

const app = await startApp({ port: 9487, seed });
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}
const shoot = async (name: string) => {
	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, "base64"));
};
const openSettings = (page: string) =>
	app.evaluate(`(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		if (!document.querySelector(".ly-settings, [data-settings]")) {
			document.querySelector(".ly-sidebar-foot button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await wait(1100);
		}
		[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === ${JSON.stringify(page)})?.click();
		await wait(1100);
		return true;
	})()`);

try {
	await mkdir(dir, { recursive: true });
	await settle(2400);

	/* ---------- 1. 默认主题 ---------- */

	const surface = await app.evaluate<{ bg: string; fg: string; shell: string; ink: string }>(`(() => {
		const root = getComputedStyle(document.documentElement);
		return {
			bg: root.getPropertyValue("--ly-code-bg").trim(),
			fg: root.getPropertyValue("--ly-code-fg").trim(),
			shell: root.getPropertyValue("--color-shell").trim(),
			ink: root.getPropertyValue("--color-ink").trim(),
		};
	})()`);
	process.stdout.write(`\n── 默认主题 ──\n  代码表面 ${surface.bg} / ${surface.fg}\n  应用表面 ${surface.shell} / ${surface.ink}\n`);
	check(
		"全新安装下，代码表面就是应用自己的表面（没有被主题重新上色）",
		surface.bg.toLowerCase() === surface.shell.toLowerCase() && surface.fg.toLowerCase() === surface.ink.toLowerCase(),
		`${surface.bg} vs ${surface.shell}`,
	);

	await openSettings("外观");
	const themeNames = await app.evaluate<string[]>(
		`[...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter((t) => t === "Plume 默认")`,
	);
	check("外观页两个下拉都停在「Plume 默认」上", themeNames.length === 2, `找到 ${themeNames.length} 个`);

	/* ---------- 3. 代码外观的预览 ---------- */

	const specimen = await app.evaluate<{
		textareas: number;
		pencils: number;
		resets: number;
		colours: number;
		overlap: boolean;
	}>(`(() => {
		const boxes = [...document.querySelectorAll('[class*="group/spec"]')];
		const first = boxes[0];
		const spans = first ? [...first.querySelectorAll("span[style*=color]")] : [];
		const colours = new Set(spans.map((s) => getComputedStyle(s).color));
		// The reset lives in the header row beside the theme's name; overlapping means it is
		// positioned over it instead of laid out next to it.
		const reset = first?.querySelector('button[aria-label="还原示例内容"]');
		const label = [...(first?.querySelectorAll("span") ?? [])].find((s) => s.textContent?.trim() === "Plume 默认");
		let overlap = false;
		if (reset && label) {
			const a = reset.getBoundingClientRect();
			const b = label.getBoundingClientRect();
			overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
		}
		return {
			textareas: boxes.filter((box) => box.querySelector("textarea")).length,
			pencils: document.querySelectorAll('[aria-label="编辑预览内容"]').length,
			resets: boxes.filter((box) => box.querySelector('button[aria-label="还原示例内容"]')).length,
			colours: colours.size,
			overlap,
		};
	})()`);

	process.stdout.write(`\n── 代码外观的两个预览 ──\n`);
	check("两个预览都能直接打字（各有一个 textarea）", specimen.textareas === 2, `${specimen.textareas} 个`);
	check("那个铅笔按钮没了", specimen.pencils === 0, `${specimen.pencils} 个`);
	check("默认状态下不显示还原（没什么可还原的）", specimen.resets === 0, `${specimen.resets} 个`);
	check("预览是带高亮的", specimen.colours >= 4, `${specimen.colours} 种颜色`);

	// Type into the first specimen, and check the highlighting survives it.
	await app.evaluate(`(() => {
		const area = document.querySelector('[class*="group/spec"] textarea');
		if (!area) return false;
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
		setter.call(area, "// 我自己的代码\\nconst answer: number = 42;");
		area.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);
	await settle(900);

	const afterTyping = await app.evaluate<{ colours: number; resets: number; overlap: boolean; text: string }>(`(() => {
		const boxes = [...document.querySelectorAll('[class*="group/spec"]')];
		const first = boxes[0];
		const spans = [...first.querySelectorAll("span[style*=color]")];
		const reset = first.querySelector('button[aria-label="还原示例内容"]');
		const label = [...first.querySelectorAll("span")].find((s) => s.textContent?.trim() === "Plume 默认");
		let overlap = false;
		if (reset && label) {
			const a = reset.getBoundingClientRect();
			const b = label.getBoundingClientRect();
			overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
		}
		return {
			colours: new Set(spans.map((s) => getComputedStyle(s).color)).size,
			resets: boxes.filter((box) => box.querySelector('button[aria-label="还原示例内容"]')).length,
			overlap,
			text: first.querySelector("textarea")?.value ?? "",
		};
	})()`);

	check("打进去的内容确实被两个框都接住了", afterTyping.text.includes("我自己的代码"), afterTyping.text.slice(0, 24));
	check("自己写的代码仍然有高亮（旧版本这里会掉色）", afterTyping.colours >= 3, `${afterTyping.colours} 种颜色`);
	check("改过之后才出现还原按钮，两个框各一个", afterTyping.resets === 2, `${afterTyping.resets} 个`);
	check("还原按钮没有压在主题名上", !afterTyping.overlap, afterTyping.overlap ? "重叠了" : "不重叠");

	/*
	 * The overlay has to line up to the pixel, or the caret sits beside the glyph it is in front of.
	 *
	 * This is the one real risk in drawing a transparent textarea over a coloured copy: the two are
	 * different elements with different UA defaults for `white-space`, `tab-size` and padding, and
	 * any of them shifts one layer relative to the other. Measured by putting a probe span at a
	 * known character and comparing it against where the textarea puts the same character.
	 */
	const alignment = await app.evaluate<{ dx: number; dy: number; font: boolean; note: string }>(`(() => {
	  try {
		const box = document.querySelector('[class*="group/spec"]');
		const area = box && box.querySelector("textarea");
		if (!area) return { dx: -1, dy: -1, font: false, note: "找不到 textarea" };
		// Both layers live in the same wrapper: the rendered lines, then the textarea over them.
		const wrap = area.parentElement;
		/*
		 * The rendered *line*, not the span inside it.
		 *
		 * A span box is the glyph box and sits centred in the line box, so comparing it against the
		 * textarea first line reports half the leading as a misalignment — 1.5px at 12px/1.6, which
		 * is measurement error rather than drift. The line div is the line box, which is what the
		 * textarea lays its own first line out as.
		 */
		const first = wrap && wrap.querySelector("div");
		if (!first) return { dx: -1, dy: -1, font: false, note: "找不到渲染层" };
		const a = getComputedStyle(area);
		const r = getComputedStyle(first);
		const areaBox = area.getBoundingClientRect();
		const firstBox = first.getBoundingClientRect();
		// Where each layer actually starts drawing: its box plus its own left padding. The line div
		// carries a negative margin and matching padding, so its box starts 12px left of the text —
		// comparing boxes alone reports that offset as drift. What must match is where glyphs land.
		return {
			dx: Math.abs((areaBox.left + parseFloat(a.paddingLeft)) - (firstBox.left + parseFloat(r.paddingLeft))),
			dy: Math.abs((areaBox.top + parseFloat(a.paddingTop)) - firstBox.top),
			font:
				a.fontFamily === r.fontFamily &&
				a.fontSize === r.fontSize &&
				a.letterSpacing === r.letterSpacing &&
				a.lineHeight === r.lineHeight,
			note: a.fontSize + " / " + r.fontSize + "  行高 " + a.lineHeight + " / " + r.lineHeight,
		};
	  } catch (e) { return { dx: -1, dy: -1, font: false, note: "抛错：" + String(e && e.message || e) }; }
	})()`);
	check(
		"两层的字体度量完全一致（字体、字号、字距、行高）",
		alignment.font,
		alignment.note,
	);
	check(
		"两层的起点重合（误差小于 1px）",
		alignment.dx < 1 && alignment.dy < 1.5,
		`水平差 ${alignment.dx.toFixed(2)}px，垂直差 ${alignment.dy.toFixed(2)}px`,
	);

	// Scrolled to the specimens, so the screenshot shows the thing being described.
	await app.evaluate(`(() => { document.querySelector('[class*="group/spec"]')?.scrollIntoView({ block: "center" }); return true; })()`);
	await settle(600);
	await shoot("01-appearance");

	process.stdout.write(`\n截图：${dir}\n`);
} finally {
	await app.stop();
}

process.exit(failures === 0 ? 0 : 1);
