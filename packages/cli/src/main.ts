#!/usr/bin/env node
/**
 * `lyra` — run one task non-interactively and print the answer.
 *
 * stdout carries the answer (or `--json`'s one object) and nothing else; progress goes to stderr.
 * Models, keys, permissions, MCP servers and skills come from the desktop app's `~/.lyra`.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bootHostKernel, loadSettings, registerDefaultSearchProviders } from "@lyra/core";
import { loadCachedModelCatalog } from "@lyra/core/model-catalog-sync";
import { runOnce, SetupError } from "./run.ts";

const USAGE = `用法：lyra [选项] <任务>
      echo <任务> | lyra [选项]

非交互地跑完一个任务：进度写到 stderr，最终回答写到 stdout。
任务可以是 /命令 参数 或 /skill 名 参数，和桌面端输入框的写法一样。
模型、权限、MCP 与 skill 读取桌面端的设置（~/.lyra）；需要授权的操作会被拒绝。

选项：
  -C, --cwd <目录>   在这个目录里工作（默认当前目录）
      --json         stdout 输出一个 JSON：status、answer、error、sessionId、usage
  -h, --help         显示这段说明

退出码：0 完成 · 1 未完成（出错、停止、达到轮数上限） · 2 用法或设置有误`;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: { cwd: { type: "string", short: "C" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
		});
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (parsed.values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const prompt = (parsed.positionals.length > 0 ? parsed.positionals.join(" ") : process.stdin.isTTY ? "" : await readStdin()).trim();
	if (!prompt) {
		console.error(USAGE);
		return 2;
	}

	// The cached catalogue first, so the settings read below carry its current values — as the desktop does.
	await loadCachedModelCatalog().catch(() => false);
	const settings = await loadSettings();
	const log = (line: string) => process.stderr.write(`${line}\n`);
	const kernel = await bootHostKernel(settings, log);
	registerDefaultSearchProviders(() => settings.searchApiKeys);

	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const result = await runOnce({ prompt, cwd: resolve(parsed.values.cwd ?? process.cwd()), settings, store: kernel.storage, log, signal: controller.signal });
		if (parsed.values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else {
			if (result.answer) process.stdout.write(`${result.answer}\n`);
			if (result.status !== "done") log(`! 未完成：${result.status}${result.error ? ` · ${result.error}` : ""}`);
		}
		return result.status === "done" ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return error instanceof SetupError ? 2 : 1;
	} finally {
		await kernel.dispose().catch(() => {});
	}
}

// Exit explicitly: a plugin or MCP client that leaves a handle open must not keep a finished run alive.
// After stdout drains, though — a piped answer is written asynchronously and an early exit cuts it off.
const code = await main();
process.stdout.write("", () => process.exit(code));
