/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Whether opening the screenshot overlay takes the app out of the Dock.
 *
 * The report is that the icon disappears from the Dock the moment a capture starts, on a packaged
 * build. An icon vanishing from the Dock is macOS saying the application's activation policy is no
 * longer `regular` — a `UIElement` (accessory) application has no Dock tile by definition — so the
 * question is answerable without looking at the Dock at all: ask LaunchServices what type it
 * thinks this process is, before and after.
 *
 * `lsappinfo` needs no accessibility grant, which is what makes this runnable unattended.
 *
 * Run: `node --experimental-strip-types e2e/dock-policy-probe.ts`
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const PORT = 9413;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What LaunchServices calls this process: `Foreground`, `UIElement` or `BackgroundOnly`.
 *
 * Matched on pid rather than name, because a development build and an installed one are called
 * different things and both are "the app" as far as this is concerned.
 */
async function appType(pid: number): Promise<string | null> {
	const { stdout } = await execFileAsync("lsappinfo", ["list"], { maxBuffer: 32 * 1024 * 1024 });
	const blocks = stdout.split(/^\s*\d+\)\s/m);
	for (const block of blocks) {
		if (!new RegExp(`pid\\s*=\\s*${pid}\\b`).test(block)) continue;
		return /type="([^"]+)"/.exec(block)?.[1] ?? "(no type)";
	}
	return null;
}

/** Every pid LaunchServices knows about that belongs to this app's process tree. */
async function appPids(name: string): Promise<number[]> {
	const { stdout } = await execFileAsync("lsappinfo", ["list"], { maxBuffer: 32 * 1024 * 1024 });
	const out: number[] = [];
	for (const block of stdout.split(/^\s*\d+\)\s/m)) {
		if (!block.includes(name)) continue;
		const pid = /pid\s*=\s*(\d+)/.exec(block);
		if (pid) out.push(Number(pid[1]));
	}
	return out;
}

const app = await startApp({ port: PORT });
const problems: string[] = [];

try {
	await pause(1500);
	const pids = await appPids("Plume");
	console.log(`• LaunchServices 认识的 Plume 进程：${pids.length ? pids.join(", ") : "(找不到，可能开发版叫别的名字)"}`);
	if (pids.length === 0) {
		const electron = await appPids("Electron");
		console.log(`  按 Electron 找到：${electron.join(", ") || "(也没有)"}`);
		pids.push(...electron);
	}
	if (pids.length === 0) throw new Error("找不到应用进程，无法判断激活策略");

	const before = await Promise.all(pids.map(async (pid) => [pid, await appType(pid)] as const));
	console.log(`• 打开浮层前：${before.map(([pid, t]) => `${pid}=${t}`).join("  ")}`);

	await app.evaluate(`window.plume.screenshot.start()`);
	await pause(2500);

	const nowPids = [...new Set([...pids, ...(await appPids("Plume")), ...(await appPids("Electron"))])];
	const during = await Promise.all(nowPids.map(async (pid) => [pid, await appType(pid)] as const));
	console.log(`• 浮层打开时：${during.map(([pid, t]) => `${pid}=${t}`).join("  ")}`);

	for (const [pid, was] of before) {
		const now = during.find(([p]) => p === pid)?.[1];
		if (was === "Foreground" && now !== "Foreground") {
			problems.push(`进程 ${pid} 的激活策略从 ${was} 变成了 ${now}——这正是 Dock 图标消失的样子`);
		}
	}

	// And back again, which is the half that decides whether it is merely a flicker or a stuck state.
	await app.evaluate(`window.plume.screenshot.cancel?.()`).catch(() => {});
	await pause(2000);
	const after = await Promise.all(nowPids.map(async (pid) => [pid, await appType(pid)] as const));
	console.log(`• 浮层关闭后：${after.map(([pid, t]) => `${pid}=${t}`).join("  ")}`);

	for (const [pid, was] of before) {
		const now = after.find(([p]) => p === pid)?.[1];
		if (was === "Foreground" && now !== "Foreground") {
			problems.push(`进程 ${pid} 关掉浮层之后仍是 ${now}，没有回到 ${was}`);
		}
	}
} finally {
	await app.stop();
}

console.log("");
if (problems.length === 0) {
	console.log("✅ 激活策略全程没有变化");
} else {
	console.log(`❌ ${problems.length} 个问题：`);
	for (const p of problems) console.log(`   - ${p}`);
	process.exitCode = 1;
}
