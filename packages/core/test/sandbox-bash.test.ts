/**
 * The sandbox, through the tool the model actually calls.
 *
 * Everything else about confinement is unit-testable and is tested that way. This file is the one
 * that answers the only question that matters at the end: when the agent runs a command, is the
 * write really refused? A profile that is generated correctly and never applied looks identical
 * from every other angle.
 *
 * Skipped where there is no backend, rather than failing: on a host without confinement these
 * assertions would be testing that an unconfined command can write, which is not a property worth
 * pinning down.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { bashTool } from "../src/tools/bash.ts";
import { selectRunner } from "../src/sandbox/backend.ts";
import { resetSystemShell } from "../src/platform.ts";
import { useSandbox } from "../src/sandbox/index.ts";
import type { SandboxProcess } from "../src/kernel/services.ts";
import type { SandboxMode } from "../src/sandbox/policy.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";
import { shellFor } from "./shell-for.ts";

const confined = selectRunner() !== "none";
const skip = confined ? false : "this host has no sandbox backend";

/*
 * Commands are spelled for the shell each mode runs in — see `shell-for.ts`. On Windows a confined
 * command runs in PowerShell, so writing a file there is `Set-Content`, not `echo >`; a test written
 * only in bash would be testing the grammar, not the sandbox.
 */

function context(cwd: string, mode: SandboxMode | undefined): ToolContext {
	return { cwd, sessionId: "test", state: new Map(), sandboxMode: mode };
}

const textOf = (result: ToolResult) => result.content.map((b) => (b.type === "text" ? b.text : "")).join("");

async function run(cwd: string, mode: SandboxMode | undefined, command: string): Promise<ToolResult> {
	return (await bashTool.execute({ command }, context(cwd, mode))) as ToolResult;
}

test("workspace-write lets a command write inside the project", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-ws-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const s = shellFor("workspace-write");
	const result = await run(ws, "workspace-write", s.thenDone(s.write(join(ws, "inside.txt"))));
	assert.match(textOf(result), /DONE/);
	assert.ok(existsSync(join(ws, "inside.txt")));
});

test("workspace-write refuses a write outside the project, and nothing is created", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-ws-"));
	// Under the home directory: outside the workspace and outside the temp areas the mode grants.
	const outside = join(homedir(), ".plume-sandbox-e2e-probe");
	t.after(async () => {
		await rm(ws, { recursive: true, force: true });
		await rm(outside, { force: true });
	});

	const result = await run(ws, "workspace-write", shellFor("workspace-write").write(outside));
	assert.equal(existsSync(outside), false, "the file must not exist — this is the whole point");
	// And the model is told it was a policy decision rather than a broken command.
	assert.match(textOf(result), /sandbox: 文件写入被拒/);
	assert.match(textOf(result), /可以申请/);
	assert.equal((result.details as { denied?: boolean }).denied, true);
});

test("read-only refuses even inside the project", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	await run(ws, "read-only", shellFor("read-only").write(join(ws, "nope.txt")));
	assert.equal(existsSync(join(ws, "nope.txt")), false);
});

test("read-only still allows the sink a shell cannot run without", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	// A read-only sandbox that cannot run `... 2>/dev/null` is not read-only, it is broken.
	const s = shellFor("read-only");
	const result = await run(ws, "read-only", s.thenDone(s.discard));
	assert.match(textOf(result), /DONE/);
});

test("read-only can still read", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	/*
	 * A file outside the workspace that exists on every platform and needs no approval to read:
	 * the temp areas are readable without asking (`read-access.ts`), `/etc/passwd` is not a file
	 * Git Bash promises, and anything under the home directory would be a question for a person.
	 */
	const other = join(tmpdir(), `plume-sb-read-${process.pid}.txt`);
	await writeFile(other, "data");
	t.after(() => rm(other, { force: true }));
	const s = shellFor("read-only");
	const result = await run(ws, "read-only", s.thenDone(s.read(other)));
	assert.match(textOf(result), /DONE/);
});

test("danger-full-access is unconfined, and says nothing about denials", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-full-"));
	const outside = join(ws, "..", `plume-full-${process.pid}.txt`);
	t.after(async () => {
		await rm(ws, { recursive: true, force: true });
		await rm(outside, { force: true });
	});

	const s = shellFor("danger-full-access");
	const result = await run(ws, "danger-full-access", s.thenDone(s.write(outside)));
	assert.match(textOf(result), /DONE/);
	assert.ok(!textOf(result).includes("sandbox:"));
});

test("no mode means no confinement, which is how the CLI and the tests run", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-none-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, undefined, "echo DONE");
	assert.match(textOf(result), /DONE/);
});

test("a path with a quote in it does not break out of the profile", { skip: skip || (process.platform === "win32" ? "a Windows path cannot contain a quote" : false) }, async (t) => {
	// The escaping is unit-tested; this proves the escaped profile is one the kernel accepts.
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-q-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const weird = join(ws, 'we"ird dir');
	const s = shellFor("workspace-write");
	const result = await run(ws, "workspace-write", s.thenDone(`${s.mkdir(weird)} && ${s.write(join(weird, "f.txt"))}`));
	assert.match(textOf(result), /DONE/, textOf(result));
});

test("an ordinary failure is not dressed up as a denial", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-fail-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, "workspace-write", "definitely-not-a-command-here");
	assert.ok(!textOf(result).includes("sandbox:"), textOf(result));
	assert.equal((result.details as { denied?: boolean }).denied, undefined);
});

function immediateExit(): SandboxProcess {
	let exited: ((code: number | null) => void) | undefined;
	setImmediate(() => exited?.(0));
	return { onOutput() {}, onExit(listener) { exited = listener; }, onError() {}, kill() {} };
}

test("the shell a command runs in is the one its session announced, escalated or not", async (t) => {
	/*
	 * On Windows a confined command runs in PowerShell and an unconfined one in Git Bash. The model
	 * writes for the shell the system prompt names, which follows the session's mode — so a command
	 * escalated to full access is still a PowerShell command, and handing it to Git Bash because the
	 * escalated mode is unconfined would run PowerShell text through bash.
	 *
	 * Pretends to be Windows with a Git Bash on hand; a recording sandbox, so nothing is started.
	 */
	const realPlatform = process.platform;
	const realShell = process.env.PLUME_SHELL;
	const bashDir = await mkdtemp(join(tmpdir(), "plume-sb-shell-"));
	await writeFile(join(bashDir, "bash.exe"), "");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	process.env.PLUME_SHELL = join(bashDir, "bash.exe");
	resetSystemShell();
	t.after(async () => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
		if (realShell === undefined) delete process.env.PLUME_SHELL;
		else process.env.PLUME_SHELL = realShell;
		resetSystemShell();
		await rm(bashDir, { recursive: true, force: true });
	});

	const shells: Array<{ mode?: SandboxMode; kind?: string }> = [];
	useSandbox({
		run(_command, options) {
			shells.push({ mode: options.mode, kind: options.shell?.kind });
			return immediateExit();
		},
	});
	t.after(() => useSandbox(null));
	const ctx = (mode: SandboxMode): ToolContext => ({
		cwd: bashDir,
		sessionId: "test",
		state: new Map(),
		sandboxMode: mode,
		requestApproval: async () => "once",
	});

	await bashTool.execute({ command: "echo hi" }, ctx("workspace-write"));
	await bashTool.execute({ command: "echo hi", escalate: "danger-full-access", justification: "要写工作区外面" }, ctx("workspace-write"));
	await bashTool.execute({ command: "echo hi", run_in_background: true }, ctx("read-only"));
	await bashTool.execute({ command: "echo hi" }, ctx("danger-full-access"));

	assert.deepEqual(shells, [
		{ mode: "workspace-write", kind: "powershell" },
		{ mode: "danger-full-access", kind: "powershell" },
		{ mode: "read-only", kind: "powershell" },
		{ mode: "danger-full-access", kind: "posix" },
	]);
});


test("命令在所有文件权限模式下都可以联网", { skip }, async (t) => {
	// 非回环地址才能发现「只允许 localhost」的回归；临时服务避免依赖公网 TLS 和可用性。
	const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
	if (!address) {
		t.skip("this host has no non-loopback IPv4 address");
		return;
	}
	const ws = await mkdtemp(join(tmpdir(), "plume-sb-net-"));
	t.after(() => rm(ws, { recursive: true, force: true }));
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain", connection: "close" });
		res.end("ok");
	});
	t.after(() => new Promise<void>((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	}));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, address, resolve);
	});
	const url = `http://${address}:${(server.address() as AddressInfo).port}/`;
	const curl = process.platform === "win32" ? "curl.exe" : "curl";
	const sink = process.platform === "win32" ? "NUL" : "/dev/null";
	const reach = (mode: SandboxMode) => run(ws, mode, `${curl} --noproxy '*' -sS -m 5 -o ${sink} -w '%{http_code}' ${url}`);
	const control = await reach("danger-full-access");
	if (control.isError || !/^200\b/.test(textOf(control))) {
		t.skip(`本机无法访问测试服务，对照组结果：${textOf(control).slice(0, 80)}`);
		return;
	}
	for (const mode of ["read-only", "workspace-write"] as const) {
		const result = await reach(mode);
		assert.match(textOf(result), /^200\b/, `${mode}: ${textOf(result)}`);
		assert.equal(result.isError, false);
	}
});
