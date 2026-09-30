/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 索引库页面自己选项目：默认列表第一个，和当前会话属于哪个项目无关，下拉切过去数字跟着换。
 *
 * 两个项目：alpha 排在列表第一，beta 最近打开过——启动后工作区落在 beta 上。索引库打开时必须
 * 是 alpha；切到 beta 后，状态、试搜都换成 beta 的。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/index-project-picker-demo.ts`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "./app.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume索引库项目测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9791;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

let alphaPath = "";
let betaPath = "";

async function seed(home: string): Promise<void> {
	alphaPath = join(home, "alpha");
	betaPath = join(home, "beta");
	await mkdir(join(alphaPath, "src"), { recursive: true });
	await mkdir(join(betaPath, "src"), { recursive: true });
	await writeFile(join(alphaPath, "src", "alpha.ts"), "export function alphaOnly() {}\n");
	// Beta gets more files, so the two projects' figures cannot be mistaken for each other.
	for (const n of [1, 2, 3]) {
		await writeFile(join(betaPath, "src", `beta${n}.ts`), `export function betaOnly${n}() {}\nexport class BetaThing${n} {}\n`);
	}
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 40, y: 40 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [
				{ id: "alpha", name: "alpha", path: alphaPath, pinned: true, lastOpenedAt: 1 },
				{ id: "beta", name: "beta", path: betaPath, pinned: true, lastOpenedAt: 2 },
			],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "off",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
		}),
	);
}

let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const frames: Frame[] = [];

async function shot(name: string) {
	const picture = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
}

try {
	await mkdir(out, { recursive: true });
	app = await startApp({ port: PORT, seed });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");

	async function until(expression: string, ms = 20_000) {
		for (let i = 0; i < ms / 100; i++) {
			if (await app!.evaluate(`Boolean(${expression})`)) return;
			await pause(100);
		}
		throw new Error(`UI condition not reached: ${expression}`);
	}
	async function clickAt(expression: string) {
		const at = await app!.evaluate<[number, number]>(
			`(()=>{const el=${expression};el.scrollIntoView({block:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
		);
		await app!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] });
		for (const type of ["mousePressed", "mouseReleased"]) {
			await app!.send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
		}
	}
	const row = (label: string) =>
		app!.evaluate<string>(`(() => {
			const r = [...document.querySelectorAll("[data-settings-row]")].find((each) => each.firstElementChild?.firstElementChild?.textContent === ${JSON.stringify(label)});
			return r ? (r.lastElementChild?.textContent ?? "").trim() : "";
		})()`);
	const projectDetail = () =>
		app!.evaluate<string>(`(() => {
			const r = [...document.querySelectorAll("[data-settings-row]")].find((each) => each.firstElementChild?.firstElementChild?.textContent === "项目");
			return r?.firstElementChild?.children[1]?.textContent ?? "";
		})()`);

	// The workspace is beta — the composer's project chip says so.
	await until(`document.querySelector("main")?.innerText.includes("beta")`);
	check("启动后当前工作区是 beta（输入框项目按钮）", true, "beta");
	await pause(1000);

	await clickAt(`document.querySelector(".ly-sidebar-foot button")`);
	await until(`[...document.querySelectorAll("nav button")].some((b) => (b.textContent || "").trim() === "索引库")`);
	await pause(500);
	await clickAt(`[...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").trim() === "索引库")`);
	await until(`document.querySelector("[data-ly-index-rebuild]")`);
	await pause(1000);

	const firstDetail = await projectDetail();
	const firstLabel = await app.evaluate<string>(`document.querySelector("[data-settings-row] [data-ly-select]")?.textContent ?? ""`);
	check("索引库默认显示列表第一个项目 alpha，而不是当前工作区 beta", firstDetail === alphaPath && firstLabel.includes("alpha"), { firstDetail, firstLabel });
	await shot("01_默认列表第一个alpha");

	await clickAt(`document.querySelector("[data-ly-index-rebuild]")`);
	await until(`/^[1-9]/.test([...document.querySelectorAll("[data-settings-row]")].find((r) => r.firstElementChild?.firstElementChild?.textContent === "已索引文件")?.lastElementChild?.textContent ?? "")`);
	await pause(1000);
	const alphaFiles = await row("已索引文件");
	check("alpha 建立索引后文件数是 1", alphaFiles === "1", alphaFiles);

	await clickAt(`document.querySelector("[data-settings-row] [data-ly-select]")`);
	await until(`[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent?.includes("beta"))`);
	await pause(900);
	await shot("02_下拉列出两个项目");
	const offered = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent ?? "")`);
	check("下拉里列出了 alpha 和 beta", offered.some((t) => t.includes("alpha")) && offered.some((t) => t.includes("beta")), offered);
	await clickAt(`[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes("beta"))`);
	await until(`[...document.querySelectorAll("[data-settings-row]")].some((r) => r.textContent?.includes(${JSON.stringify(betaPath)}))`);
	await pause(1000);
	const betaDetail = await projectDetail();
	check("切到 beta 后项目路径换成 beta", betaDetail === betaPath, betaDetail);

	await clickAt(`document.querySelector("[data-ly-index-rebuild]")`);
	await until(`([...document.querySelectorAll("[data-settings-row]")].find((r) => r.firstElementChild?.firstElementChild?.textContent === "已索引文件")?.lastElementChild?.textContent ?? "").trim() === "3"`);
	await pause(800);
	const betaFiles = await row("已索引文件");
	check("beta 建立索引后文件数是 3", betaFiles === "3", betaFiles);

	await app.evaluate(`(() => { const el = document.querySelector('input[placeholder^="输入符号名"]'); el.focus(); })()`);
	await app.send("Input.insertText", { text: "betaOnly" });
	await until(`document.body.innerText.includes("betaOnly1")`);
	await pause(1200);
	const hits = await app.evaluate<number>(`[...document.querySelectorAll("button")].filter((b) => /betaOnly\\d/.test(b.textContent ?? "")).length`);
	check("试搜在 beta 里找到 3 个 betaOnly", hits === 3, hits);
	await shot("03_切到beta后试搜");

	await clickAt(`document.querySelector("[data-settings-row] [data-ly-select]")`);
	await until(`[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent?.includes("alpha"))`);
	await pause(700);
	await clickAt(`[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes("alpha"))`);
	await until(`[...document.querySelectorAll("[data-settings-row]")].some((r) => r.textContent?.includes(${JSON.stringify(alphaPath)}))`);
	await pause(1200);
	const backFiles = await row("已索引文件");
	const alphaHits = await app.evaluate<number>(`[...document.querySelectorAll("button")].filter((b) => /betaOnly\\d/.test(b.textContent ?? "")).length`);
	check("切回 alpha：文件数回到 1，试搜不再有 beta 的符号", backFiles === "1" && alphaHits === 0, { backFiles, alphaHits });
	await shot("04_切回alpha");
	await pause(800);
} catch (error) {
	check("验证脚本跑完", false, String(error));
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_索引库按项目切换_${pass}of${checks.length}`;
	if (frames.length) await encode(frames, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${join(out, name)} (${frames.length} captured frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
