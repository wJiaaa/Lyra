/**
 * Screenshots of the file pane holding a spreadsheet, a database, a PDF, a Word document and an
 * image — one PNG each, for looking at.
 *
 * `node e2e/shot-documents.ts <dir>`. The files are built here rather than committed: a workbook
 * and a database are generated, and the PDF and .docx come from `/tmp/docs-demo`, which the caller
 * prepares with `textutil` and `cupsfilter`.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";

const outDir = process.argv[2] ?? "/tmp/plume-doc-shots";
const repo = "/tmp/plume-docs-shot";
const trayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "tray");

rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
mkdirSync(outDir, { recursive: true });

// A workbook with two sheets, a formatted percentage and a wide-ish grid.
{
	const { utils, write } = await import("xlsx");
	const book = utils.book_new();
	const sheet = utils.aoa_to_sheet([
		["季度", "收入", "成本", "毛利率", "备注"],
		["Q1", 128000, 74000, 0.42, "开局稳"],
		["Q2", 143500, 80100, 0.44, "投放收敛"],
		["Q3", 96200, 71800, 0.25, "淡季"],
		["Q4", 201400, 96300, 0.52, "旺季 + 新客"],
	]);
	for (const cell of ["D2", "D3", "D4", "D5"]) sheet[cell].z = "0%";
	utils.book_append_sheet(book, sheet, "季度汇总");
	utils.book_append_sheet(book, utils.aoa_to_sheet([["渠道", "占比"], ["直客", "0.61"], ["代理", "0.39"]]), "渠道");
	writeFileSync(join(repo, "报表.xlsx"), write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

// A database with a couple of tables, including a BLOB and a NULL.
{
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(join(repo, "app.sqlite"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, avatar BLOB, created_at TEXT)");
	db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, tokens INTEGER)");
	const insert = db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)");
	insert.run(1, "小明", "ming@example.com", new Uint8Array([1, 2, 3, 4, 5, 6]), "2026-08-01 09:12:00");
	insert.run(2, "小红", "hong@example.com", null, "2026-08-03 14:20:11");
	insert.run(3, "Alice", "alice@example.com", null, "2026-08-11 22:03:47");
	const session = db.prepare("INSERT INTO sessions VALUES (?, ?, ?)");
	session.run("s-001", 1, 128_400);
	session.run("s-002", 2, 41_900);
	db.close();
}

copyFileSync(join(trayDir, "tray@2x.png"), join(repo, "icon.png"));
for (const [from, to] of [
	["/tmp/docs-demo/demo.pdf", "说明.pdf"],
	["/tmp/docs-demo/demo.docx", "说明.docx"],
] as const) {
	if (existsSync(from)) copyFileSync(from, join(repo, to));
}

const app = await startApp({
	port: 9470,
	seed: async (home) => {
		writeFileSync(join(home, "window.json"), JSON.stringify({ width: 1340, height: 900, x: 0, y: 0 }));
		writeFileSync(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: repo, name: "docs", pinned: false, lastOpenedAt: Date.now() }],
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
				appearance: { theme: process.env.PLUME_SHOT_THEME === "light" ? "light" : "dark" },
			}),
		);
	},
});

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const shoot = async (name: string) => {
	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
	process.stdout.write(`wrote ${name}.png\n`);
};

try {
	await settle(2500);

	/*
	 * ⌘P opens the file pane. It is not on the quick row, and driving the overflow menu from a
	 * script means depending on how a menu item happens to be marked up — the shortcut is the
	 * app's own published way in.
	 */
	for (const type of ["rawKeyDown", "char", "keyUp"] as const) {
		await app.send("Input.dispatchKeyEvent", {
			type,
			modifiers: 4, // ⌘
			key: "p",
			code: "KeyP",
			windowsVirtualKeyCode: 80,
			nativeVirtualKeyCode: 80,
			text: type === "char" ? "p" : undefined,
		});
	}
	await settle(2200);
	const opened = await app.evaluate<boolean>(`Boolean(document.querySelector("[data-path]"))`);
	process.stdout.write(`file pane: ${opened}\n`);

	for (const [file, name] of [
		["报表.xlsx", "01-xlsx"],
		["app.sqlite", "02-sqlite"],
		["说明.pdf", "03-pdf"],
		["说明.docx", "04-docx"],
		["icon.png", "05-image"],
	] as const) {
		const hit = await app.evaluate<boolean>(`(() => {
			const row = [...document.querySelectorAll("[data-path]")].find((el) => (el.getAttribute("data-path") ?? "").endsWith(${JSON.stringify(file)}));
			row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			return Boolean(row);
		})()`);
		process.stdout.write(`${file}: ${hit ? "opened" : "NOT FOUND"}\n`);
		await settle(2600);
		await shoot(name);
	}
} finally {
	await app.stop();
}
