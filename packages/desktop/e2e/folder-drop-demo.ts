/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 文件夹附件（和文件一样是句子里的一枚标记），以及拖进会话卡片的蒙版——在真窗口里拖、看、点，边验边录。
 *
 * 用法：node --experimental-strip-types e2e/folder-drop-demo.ts [before|after]
 */

import { createHash } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const PORT = 9743;
const SESSION = "f01de4a0-0000-4000-8000-000000000001";
const OUT = join(homedir(), "Desktop", "Plume文件夹附件测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const mode = process.argv[2] ?? "after";

let app: RunningApp;
let outside = "";
const checks: boolean[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push(ok);
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

async function seed(home: string): Promise<void> {
	const root = join(await realpath(home), "project");
	outside = join(await realpath(home), "outside");
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(outside, "pi"), { recursive: true });
	await writeFile(join(outside, "pi", "x.txt"), "hi\n");
	await writeFile(join(outside, "starship.toml"), "format = \"$all\"\n");
	await writeFile(join(outside, "app.ts"), "export {};\n");
	await writeFile(join(outside, "SKILL.md"), "# skill\n");
	await writeFile(join(outside, "报告.docx"), "not really a docx");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 900, x: 0, y: 0 }));
	const projectId = createHash("sha256").update(root).digest("hex").slice(0, 16);
	const now = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "文件夹附件", cwd: root, projectId, projectName: "project", createdAt: now, updatedAt: now, modelId: "qa/model", messageCount: 2, usage, seq: 0 };
	const pi = join(outside, "pi");
	// 发出去的那一条：和输入框发出的形状一致——给模型的是带路径的一行，给人看的是标记加卡片。
	const user = {
		role: "user",
		content: [
			{ type: "text", text: `\n\n[Attached folder: pi — folder at ${JSON.stringify(pi)}; contents not included, read it with your tools if needed]\n\n` },
			{ type: "text", text: "看看【pi】里有什么" },
		],
		displayText: "看看【pi】里有什么",
		attachments: [{ name: "pi", kind: "folder", mimeType: "inode/directory", path: pi }],
		timestamp: now,
	};
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: now, type: "meta", meta },
			{ seq: 2, ts: now, type: "message", message: user },
			{ seq: 3, ts: now, type: "message", message: { role: "assistant", content: [{ type: "text", text: "里面只有一个 x.txt。" }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: now } },
			{ seq: 4, ts: now, type: "meta", meta: { ...meta, seq: 3 } },
		] as never,
	}]);
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1, mcpServers: [],
		providers: [{
			id: "qa", name: "探针", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
		}],
		defaultModelId: "qa/model",
		projects: [{ id: projectId, name: "project", path: root, pinned: true, lastOpenedAt: now }],
		permissionMode: "auto", thinking: "medium", retryAttempts: 3,
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [], sync: { enabled: false },
	}));
}

async function shoot(name: string): Promise<void> {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, `${STAMP}_${mode}_${name}.png`), Buffer.from(image.data, "base64"));
}

const FIELD = `document.querySelector(".ly-composer textarea")`;
/** 暗色主题下文件树给的颜色，见 `ui/fileIcon.tsx`：文件夹蓝灰、toml 土黄、TS 蓝。 */
const FOLDER = "rgb(147, 174, 214)";
const TOML = "rgb(189, 168, 120)";
const TS = "rgb(99, 166, 232)";

/** 指针在页面上的一点，换成 CDP 系统拖放的一步。 */
async function drag(type: "dragEnter" | "dragOver" | "drop" | "dragCancel", at: { x: number; y: number }, files: string[]) {
	await app.send("Input.dispatchDragEvent", { type, ...at, data: { items: [], files, dragOperationsMask: 1 } });
}

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await until(app, `!!${FIELD}`, 1800);
		await frames(app, 30);
		const files = [join(outside, "pi"), join(outside, "starship.toml"), join(outside, "app.ts"), join(outside, "SKILL.md"), join(outside, "报告.docx")];

		if (mode === "before") {
			const at = await app.evaluate<{ x: number; y: number }>(`(() => { const r = ${FIELD}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
			for (const type of ["dragEnter", "dragOver", "drop"] as const) await drag(type, at, files);
			await until(app, `${FIELD}.value.includes("【")`);
			await pause(600);
			await shoot("01_拖进文件夹和文件");
			return;
		}
		// `composer` 只跑输入框那几段，停在新对话页：会话页打不开时（别的改动把它弄崩了）也能量标记和蒙版。
		const inSession = mode !== "composer";
		const BUBBLE = '.ly-user-bubble .ly-attachment-token[data-kind="folder"]';
		if (inSession) {
		await openSession(app, SESSION);
		await until(app, `!!document.querySelector(${JSON.stringify(BUBBLE)})`);
		await pause(1000);

		console.log("1. 已发出的消息：文件夹和文件一样是句子里的一枚标记，图标是文件夹");
		const sent = await app.evaluate<{ text: string; colour: string | null; strip: number }>(`(() => {
			const token = document.querySelector(${JSON.stringify(BUBBLE)});
			const glyph = token.querySelector(".ly-token-glyph");
			return { text: token.textContent, colour: glyph ? getComputedStyle(glyph).color : null, strip: document.querySelectorAll(".ly-user-images").length };
		})()`);
		check("气泡里那枚标记写着 pi", sent.text.includes("pi"), sent.text);
		check("标记的图标是文件树里那枚蓝灰的文件夹", sent.colour === FOLDER, sent.colour);
		check("气泡外面没有另画一张卡片", sent.strip === 0, sent.strip);
		await shoot("01_已发出的消息里的文件夹标记");
		}

		console.log("2. 拖着文件悬在转录上：整张会话卡片（连标题栏）盖上蒙版");
		const surface = await app.evaluate<{ x: number; y: number; w: number; h: number; header: number }>(`(() => {
			const card = document.querySelector(".ly-composer").closest(".ly-dock-card");
			const r = card.getBoundingClientRect();
			const chat = card.querySelector("[data-ly-chat-surface]").getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, header: chat.y - r.y };
		})()`);
		check("会话卡片顶上确实有一条标题栏", surface.header > 20, surface.header);
		const path = [{ x: surface.x + surface.w * 0.8, y: surface.y + 20 }, { x: surface.x + surface.w * 0.6, y: surface.y + 220 }, { x: surface.x + surface.w * 0.5, y: surface.y + 320 }];
		await drag("dragEnter", path[0], files);
		for (const at of path) {
			await drag("dragOver", at, files);
			await pause(350);
		}
		await until(app, `!!document.querySelector("[data-ly-drop-overlay]")`);
		await pause(400);
		const overlay = await app.evaluate<{ x: number; y: number; w: number; h: number; label: string; cx: number; cy: number; events: string; radius: string }>(`(() => {
			const el = document.querySelector("[data-ly-drop-overlay]");
			const r = el.getBoundingClientRect();
			const l = el.querySelector(".ly-drop-overlay-label").getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, label: el.innerText, cx: l.x + l.width / 2 - (r.x + r.width / 2), cy: l.y + l.height / 2 - (r.y + r.height / 2), events: getComputedStyle(el).pointerEvents, radius: getComputedStyle(el).borderTopLeftRadius };
		})()`);
		check("蒙版盖住整张会话卡片，标题栏也在里面", overlay.radius === "12px" && Math.abs(overlay.x - surface.x) < 1 && Math.abs(overlay.y - surface.y) < 1 && Math.abs(overlay.w - surface.w) < 1 && Math.abs(overlay.h - surface.h) < 1, { overlay, surface });
		check("中间写着「松开即可添加」", overlay.label === "松开即可添加" && Math.abs(overlay.cx) < 1 && Math.abs(overlay.cy) < 1, overlay);
		check("蒙版不接事件，拖放照样落到底下那一栏", overlay.events === "none", overlay.events);
		await shoot("02_拖进会话栏时的蒙版");

		console.log("3. 拖到侧栏上：蒙版撤掉；再拖回来、按 Esc 取消：一秒内撤掉");
		await drag("dragOver", { x: 120, y: surface.y + 320 }, files);
		await frames(app, 6);
		check("拖出会话栏，蒙版撤掉", !(await app.evaluate<boolean>(`!!document.querySelector("[data-ly-drop-overlay]")`)), "仍在");
		await pause(600);
		await drag("dragOver", path[1], files);
		await until(app, `!!document.querySelector("[data-ly-drop-overlay]")`);
		check("拖回来，蒙版又盖上", true, "");
		await pause(600);
		// CDP 的取消不发 `dragleave`——正好是兜底要接住的那种情形。
		await drag("dragCancel", path[1], files);
		const started = Date.now();
		await until(app, `!document.querySelector("[data-ly-drop-overlay]")`, 180);
		const gone = Date.now() - started;
		check("取消之后一秒多一点蒙版撤掉", gone < 1600, `${gone}ms`);
		await pause(800);

		console.log("4. 再拖一次，在转录上松开");
		await drag("dragEnter", path[0], files);
		for (const at of path) {
			await drag("dragOver", at, files);
			await pause(300);
		}
		await drag("drop", path[2], files);
		await until(app, `${FIELD}.value.includes("【报告.docx】")`);
		await pause(800);
		const added = await app.evaluate<{ text: string; marks: { kind: string; text: string; colour: string | null; fallback: string; drift: number | null; em: number; widthDiff: number; padLeft: number; gap: number | null; before: number; after: number }[]; strip: number; overlay: boolean }>(`(() => ({
			text: ${FIELD}.value,
			marks: [...document.querySelectorAll('.ly-composer .ly-attachment-token')].map((el) => {
				const glyph = el.querySelector(".ly-token-glyph");
				const bracket = el.querySelector(".ly-token-bracket").getBoundingClientRect();
				const box = glyph?.getBoundingClientRect();
				const token = el.getBoundingClientRect();
				const paint = el.querySelector(".ly-token-paint").getBoundingClientRect();
				const name = el.querySelector(".ly-token-name").getBoundingClientRect();
				// 同一串字不加任何装饰排一遍：标记的总宽必须和它一样，镜像才不和 textarea 错位。
				const plain = document.createElement("span");
				plain.textContent = el.textContent;
				el.parentElement.insertBefore(plain, el);
				const plainWidth = plain.getBoundingClientRect().width;
				plain.remove();
				return {
					drift: box ? Math.abs(box.y + box.height / 2 - (bracket.y + bracket.height / 2)) : null,
					em: parseFloat(getComputedStyle(el).fontSize),
					widthDiff: Math.abs(token.width - plainWidth),
					padLeft: (box ?? bracket).left - paint.left,
					gap: box ? name.left - box.right : null,
					before: paint.left - token.left,
					after: token.right - paint.right,
					kind: el.dataset.kind,
					text: el.textContent,
					colour: glyph ? getComputedStyle(glyph).color : null,
					fallback: getComputedStyle(el.querySelector(".ly-token-bracket"), "::before").backgroundImage,
				};
			}),
			strip: document.querySelectorAll(".ly-composer [data-ly-attachments]").length,
			overlay: !!document.querySelector("[data-ly-drop-overlay]"),
		}))()`);
		const mark = (name: string) => added.marks.find((m) => m.text === `【${name}】`);
		check("输入框里按拖进来的先后落下五枚标记", added.text.trim() === "【pi】【starship.toml】【app.ts】【SKILL.md】【报告.docx】", added.text);
		const drawn = added.marks.filter((m) => m.drift !== null);
		check("每枚图标都竖向居中（偏差 ≤ 0.5px）", drawn.length === 4 && drawn.every((m) => (m.drift ?? 9) <= 0.5), drawn.map((m) => [m.text, m.drift]));
		check("标记总宽和原样文字一样（偏差 ≤ 0.5px），镜像不错位", added.marks.every((m) => m.widthDiff <= 0.5), added.marks.map((m) => [m.text, m.widthDiff]));
		check("图标和名字之间留出 0.2em", drawn.every((m) => Math.abs((m.gap ?? 0) - 0.2 * m.em) <= 0.5), drawn.map((m) => [m.text, m.gap, m.em]));
		check("图标离底色左沿 0.26em", drawn.every((m) => Math.abs(m.padLeft - 0.26 * m.em) <= 0.5), drawn.map((m) => [m.text, m.padLeft]));
		check("标记前后各空出 0.2em 上下，不贴着旁边的字", added.marks.every((m) => Math.abs(m.before - 0.2 * m.em) <= 0.5 && Math.abs(m.after - 0.16 * m.em) <= 0.5), added.marks.map((m) => [m.text, m.before, m.after]));
		check("SKILL.md 是文件树里 Markdown 的那一枚", mark("SKILL.md")?.colour === "rgb(127, 177, 232)", mark("SKILL.md"));
		check("文件夹那枚是蓝灰的文件夹图标", mark("pi")?.kind === "folder" && mark("pi")?.colour === FOLDER, mark("pi"));
		check("starship.toml 是文件树里 toml 的那一枚", mark("starship.toml")?.colour === TOML, mark("starship.toml"));
		check("app.ts 是文件树里 TS 的那一枚", mark("app.ts")?.colour === TS, mark("app.ts"));
		check("文件夹和文件不再是同一种颜色", new Set(added.marks.map((m) => m.colour)).size >= 3, added.marks);
		check("文件树认不出的 docx 退回 Word 的门类图标", mark("报告.docx")?.kind === "word" && mark("报告.docx")?.colour === null && (mark("报告.docx")?.fallback ?? "").includes("2b7cd3"), mark("报告.docx"));
		check("输入框上方没有另画一张卡片", added.strip === 0, added.strip);
		check("没有出现一串绝对路径", !added.text.includes(outside), added.text);
		check("放下之后蒙版撤掉", !added.overlay, added.overlay);
		await shoot("03_松开后输入框里的文件夹标记");
		// 标记后面接着打字：镜像和 textarea 差一点，这几个字就会和光标对不上。
		// 不用 `type`：它先全选再输入，会把标记一起换掉。光标放到末尾再输入。
		await app.evaluate(`(() => { const el = ${FIELD}; el.focus(); el.setSelectionRange(el.value.length, el.value.length); })()`);
		await app.send("Input.insertText", { text: " 这几个看一下" });
		await frames(app, 4);
		await pause(800);
		const tail = await app.evaluate<{ mirror: string; field: string }>(`({
			mirror: document.querySelector("[data-command-mirror]").textContent,
			field: ${FIELD}.value,
		})`);
		check("标记后面接着打的字，镜像里和输入框里是同一串", tail.mirror.replace(/\u200b/g, "") === tail.field, tail);
		await shoot("03b_标记后面接着打字");

		if (inSession) {
		console.log("5. 点气泡里那枚文件夹标记：打开这个文件夹；文件夹没了就说出来");
		// 访达那一头读不到（自动化权限），这里量的是同一次点击的两种结局：在的时候不报错，不在的时候报「不在了」。
		const toasts = () => app.evaluate<string>(`[...document.querySelectorAll("[role=status], [role=alert]")].map((el) => el.innerText).join(" | ")`);
		await click(app, BUBBLE);
		await pause(1200);
		const quiet = await toasts();
		check("文件夹在：点一下不报「不在了」", !quiet.includes("不在"), quiet);
		await rename(join(outside, "pi"), join(outside, "pi-moved"));
		await click(app, BUBBLE);
		let said = "";
		for (let i = 0; i < 20 && !said.includes("不在"); i += 1) {
			await pause(150);
			said = await toasts();
		}
		check("文件夹被挪走：点一下说它不在了", said.includes("pi"), said);
		await rename(join(outside, "pi-moved"), join(outside, "pi"));
		await shoot("04_文件夹被挪走后点标记");
		await pause(1500);
		}
	} finally {
		await pause(500);
		await stop();
		if (mode !== "before") await encode(recorded, join(OUT, `${STAMP}_文件夹标记与拖放蒙版_${checks.filter(Boolean).length}of${checks.length}.mp4`));
		const home = app.home;
		await app.stop();
		await rm(home, { recursive: true, force: true });
	}
}

await main();
