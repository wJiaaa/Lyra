/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 在真窗口里切换语言，验证浏览器自定义搜索地址的 aria-label 确实接上了 i18n。
 * 组件测试能证明键存在，真窗口中的同一个输入框随语言变化才证明它被读到了。
 *
 * 用法：node --experimental-strip-types e2e/audit-fixes-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume审计整改测试");
const PORT = 9463;
const SESSION_ID = randomUUID();
const WORK = "/tmp/plume-audit-fixes";

async function seed(home: string): Promise<void> {
	const cwd = join(WORK, "proj");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# 审计整改演示\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 940, x: 0, y: 0 }));

	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);

	const at = Date.now() - 600_000;
	const record = (seq: number, role: string, text: string) => ({
		seq,
		ts: at + seq * 1000,
		type: "message",
		message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 },
	});

	const meta = {
		id: SESSION_ID,
		title: "审计整改演示",
		cwd,
		projectId,
		projectName: "proj",
		createdAt: at,
		updatedAt: at,
		modelId: null,
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		seq: 0,
	};
	const records = [
		{ seq: 1, ts: at, type: "meta", meta },
		record(2, "user", "这一轮改了哪些东西？"),
		record(3, "assistant", "工具清单归一、命令分类器加固、浏览器文案按界面语言显示。"),
	];
	seedSessions(home, [{ meta, records }]);

	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "proj", path: cwd, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			// 自定义那一档，`browser.searchUrl` 的输入框只在它下面才画出来——要验的正是那个
			// `aria-label`，它曾经是一句写死的中文。
			browser: { searchEngine: "custom", searchUrl: "https://example.com/search?q=%s" },
		}),
	);
}

let app: RunningApp;
const frames: Frame[] = [];
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${what}`);
	if (!ok) failures.push(what);
};

/**
 * 走一遍设置导航，停在某一项上。用真鼠标——`.click()` 在这个界面里打不开东西。
 *
 * 设置入口只在还没打开时点。第一版每次都点，于是第二次调用把刚打开的设置又关掉了，接下来那一页
 * 的断言全部落空——报出来的样子和「这一节没写」一模一样。
 */
let settingsOpened = false;

async function openSettings(drive: ReturnType<typeof driver>, label: string): Promise<boolean> {
	/*
	 * 记一个标志，而不是去页面上问「设置开着吗」。
	 *
	 * 问过两种写法，两种都错：每次都点，第二次把刚打开的设置关掉了；改成 `document.querySelector
	 * ("nav button")` 判断，那个选择器在设置没开的时候也命中——页面别处也有 `nav`——于是一次都
	 * 没点开。这个函数自己知道它点没点过，不用猜。
	 */
	if (!settingsOpened) {
		await drive.click("[data-ly-open-settings]");
		await pause(1600);
		settingsOpened = true;
	}
	/*
	 * 标记之前先把上一次的记号摘掉，标记之后把它滚到中间。
	 *
	 * 两件事各自坑过一次。不摘旧记号，`[data-probe-nav]` 选中的永远是第一次标的那一项。不滚，
	 * 靠下的几项会停在窗口边缘——量到的是 `y=638`、窗口高 `680`，`checkVisibility()` 说可见，
	 * 真实鼠标点下去却什么都没发生，页面还停在上一页。滚到 `y=342` 之后同一次点击就进去了。
	 */
	const found = await app.evaluate<boolean>(`(() => {
		document.querySelector("[data-probe-nav]")?.removeAttribute("data-probe-nav");
		const item = [...document.querySelectorAll("nav button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)});
		if (!item) return false;
		item.setAttribute("data-probe-nav", "");
		item.scrollIntoView({ block: "center" });
		return true;
	})()`);
	if (!found) return false;
	await pause(900);
	await drive.click("[data-probe-nav]");
	await pause(1400);
	return true;
}

app = await startApp({ port: PORT, seed });
const drive = driver(app);
const stop = await startRecording(PORT, frames);

try {
	await mkdir(OUT_DIR, { recursive: true });
	await pause(2600);

	// I1：切语言，看同一个位置的字跟着走
	console.log("\n\x1b[1mI1：浏览器搜索地址文案真的走了 i18n\x1b[0m");
	const toBrowser = await openSettings(drive, "浏览器");
	check(toBrowser, "设置导航里有「浏览器」这一项");
	await pause(1200);
	const zhLabel = await app.evaluate<string | null>(
		`document.querySelector('[aria-label="自定义搜索地址"]')?.getAttribute("aria-label") ?? null`,
	);
	check(zhLabel === "自定义搜索地址", `中文界面上搜索框的 aria-label 走了 t()（${zhLabel}）`);
	await pause(800);

	const toGeneral = await openSettings(drive, "常规");
	check(toGeneral, "设置导航里有「常规」这一项");
	await pause(1000);
	/*
	 * 语言选择是自定义的 Dropdown，不是原生 `<select>`。
	 *
	 * 第一版找 `document.querySelectorAll("select")`，一个都没有——页面上那个「界面语言 ˅」是一个
	 * 带 `aria-label` 的按钮加一层弹出列表。两步真鼠标：点开，再点 English 那一行。
	 */
	const opener = await app.evaluate<boolean>(`(() => {
		const el = document.querySelector('[aria-label="界面语言"]');
		if (!el) return false;
		el.setAttribute("data-probe-lang", "");
		el.scrollIntoView({ block: "center" });
		return true;
	})()`);
	check(opener, "找得到「界面语言」那个下拉");
	let switched = false;
	if (opener) {
		await pause(700);
		await drive.click("[data-probe-lang]");
		await pause(1100);
		// 每一项是两行——一个语言标记加语言名，和收起来时那个「中 / 简体中文」一样。所以按包含匹配，
		// 并且只在 `role="menuitem"` 里找：`English` 这个词在这一页别处也出现。
		switched = await app.evaluate<boolean>(`(() => {
			const option = [...document.querySelectorAll('[role="menuitem"]')].find((n) => (n.innerText ?? "").includes("English"));
			if (!option) return false;
			option.setAttribute("data-probe-en", "");
			return true;
		})()`);
		if (switched) {
			await drive.click("[data-probe-en]");
			await pause(1600);
		}
	}
	check(switched, "下拉里点得到 English");
	await pause(1800);

	const toBrowserEn = await openSettings(drive, "Browser");
	check(toBrowserEn, "切了语言之后导航项也变成英文了（Browser）");
	await pause(1200);
	/*
	 * 只在 `[data-search-custom]` 那个盒子里找，不在整页里找 `/search/i`。
	 *
	 * 整页找会先撞上侧边栏那个 `Search chats`——一条看起来很像、其实不是它的 `aria-label`。断言
	 * 因此变绿，而变绿的理由是错的：抓错元素的绿比红更难发现。
	 */
	const enLabel = await app.evaluate<string | null>(`(() => {
		const box = document.querySelector("[data-search-custom]");
		const el = box?.querySelector("[aria-label]");
		return el ? el.getAttribute("aria-label") : null;
	})()`);
	check(
		Boolean(enLabel && !/[\u4e00-\u9fa5]/.test(enLabel)),
		`同一个 aria-label 在英文界面上不再是中文（${enLabel}）`,
	);
	await pause(900);

} finally {
	await stop();
	const video = join(OUT_DIR, "浏览器搜索地址国际化.mp4");
	await encode(frames, video, 12, 1200).catch((error: unknown) => console.error("录像失败：", error));
	console.log(`\n录像：${video}（${frames.length} 帧）`);
	await app.stop();
}

console.log(
	failures.length === 0
		? "\n\x1b[32m浏览器搜索地址文案在真窗口里随语言切换\x1b[0m"
		: `\n\x1b[31m${failures.length} 条没成立：\x1b[0m\n  ${failures.join("\n  ")}`,
);
// 不用 process.exit：它会吞掉上面 finally 里可能抛出的异常。
process.exitCode = failures.length === 0 ? 0 : 1;
