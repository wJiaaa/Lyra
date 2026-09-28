/**
 * A screenshot of this repository's own README, rendered by the app's Markdown viewer.
 *
 * Not a test — `node e2e/shot-readme.ts <out.png> [scrollTop]`, `FULL=1` for the whole window.
 * Beside the tests because it boots the app the same way they do, and next to `markdown.test.ts`
 * for the same reason `shot.ts` sits beside the plugin tests: the assertions there say a picture
 * has the right width and the right scheme, which is a description of the layout. This is the
 * layout.
 *
 * The README is the fixture on purpose. It opens with a logo, a badge row and a `<p align="center">`
 * around each — the exact shape of HTML that a Markdown renderer either honours or quietly drops.
 *
 * It also prints what it measured, since "the badge drew" and "the badge is a link that looks like
 * a badge" are the same picture at a glance and different lines of JSON.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/plume-readme.png";
const scroll = Number(process.argv[3] ?? 0);
const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

async function seed(home: string): Promise<void> {
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "readme", name: "Plume", path: REPO, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: process.env.PLUME_SHOT_THEME === "dark" ? "dark" : "light" },
		}),
	);
}

const app = await startApp({ port: 9457, seed });
try {
	await app.evaluate(`(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		document.querySelector('button[aria-label="面板"]').click();
		await wait(200);
		[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.innerText.trim().startsWith("文件"))?.click();
		await wait(900);
		const row = [...document.querySelectorAll("[role=treeitem]")].find((r) => r.getAttribute("data-path").endsWith("README.md"));
		row?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		return Boolean(row);
	})()`);
	// Long enough for the file to be read and every remote badge to come back from the network.
	await new Promise((resolve) => setTimeout(resolve, 6000));

	if (process.env.FULL) {
		// 「文件内容」is the viewer; 「文件」beside it is the tree, and expanding that one shows a
		// file list at full width, which is not the thing being looked at.
		await app.evaluate(`(async () => {
			const button = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "全屏：文件内容");
			button?.click();
			return Boolean(button);
		})()`);
		await new Promise((resolve) => setTimeout(resolve, 700));
	}

	if (scroll) {
		// The scroller is whichever ancestor of the rendered document actually overflows.
		const at = await app.evaluate<number>(`(() => {
			let el = document.querySelector(".prose-dw");
			while (el && el !== document.body) {
				if (el.scrollHeight > el.clientHeight + 40) { el.scrollTop = ${scroll}; return el.scrollTop; }
				el = el.parentElement;
			}
			return -1;
		})()`);
		process.stdout.write(`scrolled to ${at}\n`);
		await new Promise((resolve) => setTimeout(resolve, 600));
	}

	const measured = await app.evaluate<unknown>(`(() => {
		const doc = document.querySelector(".prose-dw");
		if (!doc) return "no rendered document";
		return [...doc.querySelectorAll("img")].map((img) => ({
			alt: img.alt,
			// The scheme, not the URL: a data URL is 30KB of base64 and says nothing more than "data".
			scheme: img.src.slice(0, img.src.indexOf(":")),
			drawn: img.complete && img.naturalWidth > 0,
			css: Math.round(img.getBoundingClientRect().width) + "x" + Math.round(img.getBoundingClientRect().height),
			top: Math.round(img.getBoundingClientRect().top),
		}));
	})()`);
	process.stdout.write(`${JSON.stringify(measured)}\n`);

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`wrote ${out}\n`);
} finally {
	await app.stop();
}
