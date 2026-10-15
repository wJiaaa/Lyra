import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

// 真正销毁 Electron 的 Node 环境：只测 JS 的 kill/onExit 顺序抓不到原生回调里的 SIGABRT。
for (const mode of ["quit", "exit", "settled", "throw"]) {
	test(`macOS 终端退出回调在 ${mode} 时不让应用崩溃`, { skip: process.platform !== "darwin" }, async () => {
		const home = await mkdtemp(join(tmpdir(), "plume-pty-shutdown-"));
		try {
			const entry = join(home, "main.cjs");
			await writeFile(entry, `
const { app } = require("electron");
const { spawn } = require(${JSON.stringify(require.resolve("node-pty"))});
const mode = process.argv[2];
// node-pty 的 N-API 版本通过 DEP0168 报告回调异常，而不是触发 uncaughtException。
process.on("warning", (warning) => {
	if (warning.code === "DEP0168") {
		console.log("CALLBACK_ERROR_REPORTED");
		app.quit();
	}
});
app.whenReady().then(() => {
	const pty = spawn("/bin/sh", ["-c", "printf READY; read line"], {
		cwd: ${JSON.stringify(home)}, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24,
	});
	pty.onExit(() => {
		console.log("PTY_EXIT");
		if (mode === "throw") throw new Error("exit listener failed");
		if (mode === "settled") app.quit();
	});
	let closing = false;
	pty.onData((data) => {
		if (closing || !data.includes("READY")) return;
		closing = true;
		console.log("PTY_READY");
		pty.kill();
		if (mode === "quit") app.quit();
		if (mode === "exit") app.exit(0);
	});
});
`);
			const env = { ...process.env, HOME: home, USERPROFILE: home };
			delete env.ELECTRON_RUN_AS_NODE;
			delete env.ELECTRON_RENDERER_URL;
			const result = spawnSync(require("electron"), [entry, mode], { env, encoding: "utf8", timeout: 15_000 });
			assert.equal(result.error, undefined, `${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /PTY_READY/, "必须确实启动过终端，不能空跑退出");
			assert.equal(result.signal, null, result.stderr);
			assert.equal(result.status, 0, result.stderr);
			if (mode === "settled") assert.match(result.stdout, /PTY_EXIT/, "正常运行时仍然需要通知终端退出");
			if (mode === "throw") assert.match(result.stdout, /CALLBACK_ERROR_REPORTED/, "不能吞掉正常运行时的回调异常");
			else assert.doesNotMatch(result.stdout, /CALLBACK_ERROR/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
}
