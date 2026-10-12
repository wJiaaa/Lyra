/**
 * preview 的说明改了以后，模型还会不会先截图自检、据截图改、再发布。
 *
 *   node --experimental-strip-types test/tool-eval/preview-eval.ts <模型 id ...> [--runs 2] [--task <id>] [--compare <旧 schema.json>]
 *
 * 带 `--compare` 时同一题再用那份 { description, parameters } 跑一遍，做新旧对照；那份 JSON 从改动前的
 * `previewTool` 导出，不留在仓库里。
 *
 * 工具表、系统提示词、循环都是产品的。preview 真的写页面，检查交给 `preview-inspect.cjs`（离屏 Electron，
 * 和产品的检查同一种做法）；read/write/edit/ls/glob/grep 在临时目录里真跑；其余工具只记录、回一句 ok。
 * 判通过：页面发布出去了、发布的那版没有抛异常、含任务点名的内容。「界面块」一列看回复里让人挑的那块
 * 有没有写在 ```ui 围栏里：漏了围栏，桌面端会把它原样显示成一段文字。
 *
 * 模型用 Plume 设置里已经配好的，不读出任何密钥。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "../../packages/core/src/agent/loop.ts";
import { loadSettings, resolveModel } from "../../packages/core/src/config/settings.ts";
import { buildSystemPrompt } from "../../packages/core/src/prompt/system.ts";
import { writePreview } from "../../packages/core/src/runtime/previews.ts";
import { builtinToolGroups } from "../../packages/core/src/tools/groups.ts";
import { interfaceBlocks, unfencedComponents } from "../../packages/core/src/ui-language/notes.ts";
import { usePreviewInspector as bindInspector, type PreviewInspection } from "../../packages/core/src/tools/preview.ts";
import type { AssistantMessage, Message, Tool, ToolResult } from "../../packages/core/src/types.ts";
import { requestUsage } from "../../packages/core/src/types.ts";
import { runConfig } from "../../packages/core/test/run-config.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);
const run = promisify(execFile);
const electron = createRequire(join(import.meta.dirname, "../../packages/desktop/package.json"))("electron") as string;
const HELPER = join(import.meta.dirname, "preview-inspect.cjs");

interface Task {
	id: string;
	prompt: string;
	/** 发布的那版页面里应当有的东西。 */
	check: (html: string) => boolean;
}

const has = (...needles: (string | RegExp)[]) => (html: string) => needles.every((n) => (typeof n === "string" ? html.includes(n) : n.test(html)));

const TASKS: Task[] = [
	{ id: "toggle", prompt: "Make me a small FAQ page with three questions about our coffee subscription; each answer is hidden until its question is clicked. Show it to me here.", check: has(/<button|<details|click/i) },
	{ id: "bar-chart", prompt: "Draw a bar chart of monthly sales with a value label on every bar: Jan 120, Feb 95, Mar 140, Apr 180, May 160, Jun 210.", check: has("210", "95", "Jun") },
	{ id: "pricing", prompt: "Show three pricing plans side by side — Free $0, Pro $12/month, Team $30/month — and make sure it still reads well on a phone.", check: has("$0", "$12", "$30") },
	{ id: "tabs", prompt: "Build a tabbed product card with three tabs, Overview, Specs and Reviews, that switch the content when clicked. Show it to me.", check: has("Overview", "Specs", "Reviews", /<script/i) },
	// 10-12 那次漏了界面块围栏的会话，原话。
	{ id: "pick", prompt: "我想做一个待办清单。你给我几个好看的模板 我选择一下", check: has(/<body/i) },
];

const SYSTEM_SUFFIX = "\n\nThis is an evaluation: the tools are real from your point of view. Do the task with the tools you have, then stop. Do not ask the user questions.";
const REAL = new Set(["read", "write", "edit", "ls", "glob", "grep", "preview"]);

/** 离屏 Electron 里载入一遍，回来的和产品的检查同形。 */
async function inspect(dir: string, entry: string, width: number, screenshot: boolean): Promise<PreviewInspection | null> {
	const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
	const { stdout } = await run(electron, [HELPER, dir, entry, String(width), screenshot ? "1" : "0"], { env, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
	const line = stdout.trim().split("\n").pop();
	return line ? (JSON.parse(line) as PreviewInspection) : null;
}

interface PreviewCall {
	args: Record<string, unknown>;
	isError: boolean;
	checkId?: string;
	published: boolean;
}

async function runOnce(task: Task, schema: Pick<Tool, "description" | "parameters"> | null, modelId: string) {
	const settings = await loadSettings();
	const resolved = resolveModel(settings, modelId);
	if (!resolved) throw new Error(`Model not found: ${modelId}`);
	const cwd = await mkdtemp(join(tmpdir(), "plume-preview-eval-"));
	const home = join(cwd, ".home");
	const sessionId = `preview-eval-${task.id}`;
	const dirs = new Map<string, string>();
	bindInspector(async (page, options) => inspect(dirs.get(page.id)!, page.entry, options?.width ?? 720, options?.screenshot === true));

	const other: string[] = [];
	const previews: PreviewCall[] = [];
	const tools = builtinToolGroups()
		.flat()
		.map((tool): Tool => {
			if (!REAL.has(tool.name)) {
				return { ...tool, async execute(args): Promise<ToolResult> {
					other.push(`${tool.name} ${JSON.stringify(args).slice(0, 80)}`);
					return { content: [{ type: "text", text: tool.name === "bash" ? "" : "ok" }] };
				} };
			}
			if (tool.name !== "preview") return tool;
			return {
				...tool,
				...schema,
				async execute(args, ctx): Promise<ToolResult> {
					const result = await tool.execute(args, ctx);
					const details = result.details as { kind?: string; id?: string; preview?: unknown } | undefined;
					previews.push({ args: args as Record<string, unknown>, isError: result.isError === true, ...(details?.kind === "preview-check" ? { checkId: details.id } : {}), published: Boolean(details?.preview) });
					return result;
				},
			};
		});
	const systemPrompt = (await buildSystemPrompt({ cwd, tools, skills: [], projectInstructions: [], platform: "darwin", modelName: resolved.model.name, isGitRepo: false, scratchDir: join(cwd, ".scratch") })) + SYSTEM_SUFFIX;
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: task.prompt }], timestamp: Date.now() }];
	const result = await runAgent(
		runConfig({
			session: { sessionId, systemPrompt, messages },
			model: { provider: resolved.provider, model: resolved.model, thinking: settings.thinking },
			tools: {
				available: tools,
				env: {
					cwd,
					scratchDir: join(cwd, ".scratch"),
					writePreview: async (input) => {
						const record = await writePreview(home, { ...input, sessionId });
						dirs.set(record.id, record.dir);
						return record;
					},
				},
				requestApproval: async () => "once",
			},
			control: { maxTurns: 12 },
		}),
		async () => {},
	);
	bindInspector(null);

	const replies = result.messages.filter((m): m is AssistantMessage => m.role === "assistant");
	const input = replies.reduce((sum, m) => {
		const u = requestUsage(m);
		return sum + u.input + u.cacheRead + u.cacheWrite;
	}, 0);
	const checks = previews.filter((p) => p.checkId);
	const firstCheck = previews.findIndex((p) => p.checkId);
	const htmlOf = (p: PreviewCall) => (typeof p.args.html === "string" ? p.args.html : JSON.stringify(p.args.files ?? p.args.path ?? ""));
	// 看过截图之后又交了一版不同的页面：据截图改过。
	const revised = firstCheck >= 0 && previews.slice(firstCheck + 1).some((p) => p.args.id === undefined && htmlOf(p) !== htmlOf(previews[firstCheck]!));
	const shown = [...previews].reverse().find((p) => p.published);
	const shownHtml = !shown ? "" : shown.args.id !== undefined ? await readFile(join(dirs.get(String(shown.args.id))!, "index.html"), "utf8").catch(() => "") : htmlOf(shown);
	const failed = replies.find((m) => m.stopReason === "error");
	const said = replies.flatMap((m) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))).join("\n");
	return {
		pass: Boolean(shown) && task.check(shownHtml),
		used: previews.length > 0,
		checks: checks.length,
		widths: previews.filter((p) => p.args.width !== undefined).length,
		revised,
		refused: previews.filter((p) => p.isError).length,
		published: Boolean(shown),
		ui: interfaceBlocks(said).length > 0 ? "围栏" : unfencedComponents(said).length > 0 ? "漏围栏" : "无",
		server: other.some((line) => /http\.server|npx serve|live-server|open .*\.html/.test(line)),
		other: other.length,
		requests: replies.length,
		input,
		error: failed?.errorMessage,
		// 没过时看一眼它最后说了什么：停在检查之后，还是页面内容不对。
		last: replies.at(-1)?.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ").replace(/\s+/g, " ").slice(0, 160),
	};
}

type Row = Awaited<ReturnType<typeof runOnce>>;

async function main(): Promise<void> {
	const flag = (name: string) => {
		const at = process.argv.indexOf(name);
		return at >= 0 ? process.argv[at + 1] : undefined;
	};
	const runs = Number(flag("--runs") ?? 2);
	const one = flag("--task");
	const compare = flag("--compare");
	const old = compare ? (JSON.parse(await readFile(compare, "utf8")) as Pick<Tool, "description" | "parameters">) : null;
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !["--runs", "--task", "--compare"].includes(all[i - 1]!));
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<provider>/<model>`）");
	const tasks = TASKS.filter((task) => !one || task.id === one);
	const variants: [string, Pick<Tool, "description" | "parameters"> | null][] = old ? [["old", old], ["new", null]] : [["new", null]];
	for (const modelId of models) {
		say(`\npreview 自检 · ${modelId} · 每题 ${runs} 次\n`);
		say(`${"任务".padEnd(10)} 版本 结果 用了 检查 宽度 改过 退回 发布 界面块 起服务 其他工具 请求 输入`);
		const totals: Record<string, Row[]> = {};
		for (const task of tasks) {
			for (const [name, schema] of variants) {
				for (let i = 0; i < runs; i++) {
					const r: Row = await runOnce(task, schema, modelId).catch((error: unknown) => ({ pass: false, used: false, checks: 0, widths: 0, revised: false, refused: 0, published: false, ui: "无", server: false, other: 0, requests: 0, input: 0, error: String(error), last: undefined }));
					(totals[name] ??= []).push(r);
					const yn = (v: boolean) => (v ? "是" : "否");
					say(`${task.id.padEnd(10)} ${name.padEnd(4)} ${r.pass ? "通过" : "失败"} ${yn(r.used)}   ${r.checks}    ${r.widths}    ${yn(r.revised)}   ${r.refused}    ${yn(r.published)}   ${r.ui.padEnd(4)} ${yn(r.server)}     ${String(r.other).padEnd(8)} ${String(r.requests).padEnd(4)} ${r.input}${r.error ? `  ${r.error.slice(0, 100)}` : ""}${!r.pass && r.last ? `  最后一句：${r.last}` : ""}`);
				}
			}
		}
		for (const [name, rows] of Object.entries(totals)) {
			const n = rows.length;
			const count = (f: (r: Row) => boolean) => rows.filter(f).length;
			const checked = rows.filter((r) => r.checks > 0);
			say(`${name.padEnd(4)} 通过 ${count((r) => r.pass)}/${n} · 用了 preview ${count((r) => r.used)}/${n} · 先检查 ${checked.length}/${n} · 检查后改过 ${count((r) => r.revised)}/${checked.length} · 检查了没发布 ${count((r) => r.checks > 0 && !r.published)} · 界面块漏围栏 ${count((r) => r.ui === "漏围栏")}/${count((r) => r.ui !== "无")} · 起服务 ${count((r) => r.server)} · 平均请求 ${(rows.reduce((s, r) => s + r.requests, 0) / n).toFixed(2)} · 平均输入 ${Math.round(rows.reduce((s, r) => s + r.input, 0) / n)}`);
		}
	}
}

main().catch((error) => {
	say(String(error instanceof Error ? (error.stack ?? error.message) : error));
	process.exit(1);
});
