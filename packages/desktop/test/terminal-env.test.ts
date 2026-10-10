/**
 * What a new terminal's shell is started with: the locale a Dock launch lacks, and on Windows the
 * environment as the registry has it now rather than as it was when Plume started.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createRegistryEnv, shellEnv, withRegistryEnv } from "../electron/terminal-env.ts";
import { createTerminalRegistry, type LiveTerminal } from "../electron/terminal-registry.ts";

test("a Dock launch with no locale gets a UTF-8 LC_CTYPE, and nothing else about the locale changes", () => {
	const env = shellEnv("darwin", { PATH: "/usr/bin" });
	assert.equal(env.LC_CTYPE, "en_US.UTF-8");
	assert.equal(env.LANG, undefined);
	assert.equal(env.TERM, "xterm-256color");
	assert.equal(env.COLORTERM, "truecolor");
});

test("any locale the user already has is left exactly as it is", () => {
	assert.equal(shellEnv("darwin", { LANG: "zh_CN.UTF-8" }).LC_CTYPE, undefined);
	assert.equal(shellEnv("darwin", { LC_ALL: "C" }).LC_CTYPE, undefined);
	assert.equal(shellEnv("darwin", { LC_CTYPE: "ja_JP.UTF-8" }).LC_CTYPE, "ja_JP.UTF-8");
	// Linux sessions hand their apps a locale; Windows has no such variable to fix.
	assert.equal(shellEnv("linux", {}).LC_CTYPE, undefined);
	assert.equal(shellEnv("win32", {}).LC_CTYPE, undefined);
});

test("the registry's values replace the inherited ones, user over machine, whatever their case", () => {
	const env = withRegistryEnv(
		{ JAVA_HOME: "C:\\old-jdk", Path: "C:\\Windows", USERNAME: "mochida" },
		{ JAVA_HOME: "C:\\machine-jdk", NVM_HOME: "C:\\nvm", USERNAME: "SYSTEM" },
		{ java_home: "C:\\user-jdk" },
	);
	assert.equal(env.JAVA_HOME, "C:\\user-jdk");
	assert.equal(env.java_home, undefined, "a second key differing only in case");
	assert.equal(env.NVM_HOME, "C:\\nvm");
	// The machine key's USERNAME is the service account, not the person.
	assert.equal(env.USERNAME, "mochida");
});

test("PATH is machine then user, and keeps what the launcher added, once each", () => {
	const env = withRegistryEnv(
		{ PATH: "C:\\Windows;C:\\from-launcher\\" },
		{ Path: "C:\\Windows;C:\\Program Files\\nodejs\\" },
		{ Path: "C:\\Users\\me\\AppData\\Roaming\\npm;c:\\windows" },
	);
	assert.equal(env.Path, undefined, "a second PATH key beside the inherited one");
	assert.equal(env.PATH, "C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\from-launcher\\");
});

test("a new tab waits for a read already under way, and a failed read keeps the last good answer", async () => {
	let answer: ((value: { machine: Record<string, string>; user: Record<string, string> } | null) => void) | undefined;
	const fresh = createRegistryEnv(() => new Promise((done) => (answer = done)), 1_500, 0);
	const inherited = { Path: "C:\\Windows" };

	assert.equal(fresh.current(inherited), inherited, "nothing read yet: the inherited environment as it is");
	fresh.refresh();
	const waiting = fresh.settled();
	answer?.({ machine: { Path: "C:\\Program Files\\nodejs" }, user: {} });
	await waiting;
	assert.equal(fresh.current(inherited).Path, "C:\\Program Files\\nodejs;C:\\Windows");

	fresh.refresh();
	answer?.(null);
	await fresh.settled();
	assert.equal(fresh.current(inherited).Path, "C:\\Program Files\\nodejs;C:\\Windows");
});

test("focus coming and going does not start a read each time", async () => {
	let reads = 0;
	const fresh = createRegistryEnv(async () => (reads++, null));
	fresh.refresh();
	await fresh.settled();
	fresh.refresh();
	assert.equal(reads, 1, "a second read seconds after the first finished");
});

test("a slow read does not hold a new tab for longer than the wait", async () => {
	const fresh = createRegistryEnv(() => new Promise(() => {}), 20);
	fresh.refresh();
	const started = Date.now();
	await fresh.settled();
	assert.ok(Date.now() - started < 500);
});

test("the registry starts each shell with the environment as of now", () => {
	let env: Record<string, string> = {};
	let now: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
	const registry = createTerminalRegistry({
		terminals: new Map<string, LiveTerminal>(),
		spawnPty: (_file, _args, options) => {
			env = options.env as Record<string, string>;
			return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} } as never;
		},
		insideAProject: () => false,
		eachWindow: () => {},
		platform: "win32",
		env: { Path: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
		currentEnv: () => now,
		findExecutable: () => null,
	});
	registry.open("C:\\proj", 80, 24);
	assert.equal(env.Path, "C:\\Windows");
	now = { Path: "C:\\Program Files\\nodejs;C:\\Windows" };
	registry.open("C:\\proj", 80, 24);
	assert.equal(env.Path, "C:\\Program Files\\nodejs;C:\\Windows");
});
