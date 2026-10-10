/**
 * 终端里正在跑什么：标签上写着它，关之前也凭它决定要不要问一句。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { foregroundOf, watchForeground } from "../electron/terminal-foreground.ts";
import { createTerminalRegistry, type LiveTerminal } from "../electron/terminal-registry.ts";

test("the shell itself is not a running program, however it is spelled", () => {
	assert.equal(foregroundOf({ process: "zsh" }, "/bin/zsh"), null);
	assert.equal(foregroundOf({ process: "-zsh" }, "/bin/zsh"), null);
	assert.equal(foregroundOf({ process: "pwsh.exe" }, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), null);
	assert.equal(foregroundOf({ process: "" }, "/bin/zsh"), null);
});

test("anything else in the foreground is named", () => {
	assert.equal(foregroundOf({ process: "node" }, "/bin/zsh"), "node");
	assert.equal(foregroundOf({ process: "/usr/bin/vim" }, "/bin/zsh"), "vim");
});

test("a pty that cannot say is treated as running nothing", () => {
	const pty = { get process(): string { throw new Error("gone"); } };
	assert.equal(foregroundOf(pty, "/bin/zsh"), null);
});

test("output is read once it settles, and only a change is reported", async () => {
	const pty = { process: "zsh" };
	const seen: (string | null)[] = [];
	const watch = watchForeground(pty, "/bin/zsh", (process) => seen.push(process), 5);
	pty.process = "node";
	for (let i = 0; i < 50; i++) watch.poke();
	await new Promise((done) => setTimeout(done, 30));
	watch.poke();
	await new Promise((done) => setTimeout(done, 30));
	pty.process = "zsh";
	watch.poke();
	await new Promise((done) => setTimeout(done, 30));
	assert.deepEqual(seen, ["node", null]);
	assert.equal(watch.current, null);
	watch.dispose();
});

test("the tab list says what each shell is running, and windows are told when it changes", async () => {
	let output: ((data: string) => void) | undefined;
	const pty = { pid: 1, process: "zsh", onData: (fn: (data: string) => void) => (output = fn), onExit() {}, write() {}, resize() {}, kill() {} };
	const sent: unknown[] = [];
	const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => channel === "terminal:process" && sent.push(payload) } };
	const registry = createTerminalRegistry({
		terminals: new Map<string, LiveTerminal>(),
		spawnPty: () => pty as never,
		insideAProject: () => false,
		eachWindow: (visit) => visit(window as never),
		platform: "darwin",
		env: { SHELL: "/bin/zsh" },
	});
	const { id } = registry.open("/proj", 80, 24);
	assert.equal(registry.listAll()[0]?.process, null);
	pty.process = "node";
	output?.("\r\n");
	await new Promise((done) => setTimeout(done, 400));
	assert.deepEqual(sent, [{ id, process: "node" }]);
	assert.equal(registry.listAll()[0]?.process, "node");
	registry.kill(id);
});
