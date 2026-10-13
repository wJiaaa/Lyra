/**
 * 把一次或几次 `pnpm bench` 的结果汇总成能拿来比较的数。
 *
 * Harbor 的 Mean 不能直接用：判分脚本要先从网上装 uv、Python 和 pytest，装不上时测试根本没跑，
 * 却照样写下 0 分，看上去和 agent 做错了一模一样。这里把这种题单独列出来（「未判分」），给出重跑
 * 用的 `-i` 列表；同一个 agent 的几次结果合在一起时，每道题取最早一次判了分的。
 *
 * 用法：pnpm bench:summary <job> [<job>...]   job 是 ~/.cache/plume-eval/jobs 下的目录名或完整路径
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const JOBS = join(process.env.PLUME_EVAL_CACHE || join(homedir(), ".cache", "plume-eval"), "jobs");

interface TrialResult {
	task_name: string;
	started_at: string;
	agent_info: { name: string; version: string | null; model_info: { name: string } | null };
	agent_result: { cost_usd: number | null } | null;
	verifier_result: { rewards: { reward: number } } | null;
	exception_info: { exception_type: string } | null;
}

type Outcome = "passed" | "failed" | "unscored";

interface Trial {
	task: string;
	startedAt: string;
	outcome: Outcome;
	timedOut: boolean;
	cost: number;
}

function classify(dir: string, result: TrialResult): Outcome {
	const reward = result.verifier_result?.rewards.reward;
	// 答题超时以后 Harbor 照样判分（超时的题也拿过 1 分），所以没有分数说的是判分本身没跑完——
	// 装不上、容器起不来、判分超时——和 agent 做得好不好无关。exception_info 只记第一个异常，看不到后面那个。
	if (reward === undefined) return "unscored";
	if (reward >= 1) return "passed";
	// 89 道题的判分脚本只要 pytest 真跑起来就会写 ctrf.json；没有它，0 分说的是判分环境没装好。
	return existsSync(join(dir, "verifier", "ctrf.json")) ? "failed" : "unscored";
}

function readJob(job: string): { arm: string; trials: Trial[] } {
	const root = isAbsolute(job) ? job : join(JOBS, job);
	let arm = "";
	const trials: Trial[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const file = join(root, entry.name, "result.json");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const result = JSON.parse(readFileSync(file, "utf8")) as TrialResult;
		// 没跑完的题还没有 started_at 以外的东西；跳过，等它结束。
		if (!result.verifier_result && !result.exception_info) continue;
		const agent = result.agent_info;
		arm = `${agent.name} ${agent.version ?? ""} · ${agent.model_info?.name ?? ""}`;
		trials.push({
			task: result.task_name.replace(/^terminal-bench\//, ""),
			startedAt: result.started_at,
			outcome: classify(join(root, entry.name), result),
			timedOut: result.exception_info?.exception_type === "AgentTimeoutError",
			cost: result.agent_result?.cost_usd ?? 0,
		});
	}
	return { arm, trials };
}

/** 每道题取最早一次判了分的；全都没判分，就留最早的那次，让它出现在「未判分」里。 */
function settle(trials: Trial[]): Map<string, Trial> {
	const byTask = new Map<string, Trial>();
	for (const trial of [...trials].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
		const held = byTask.get(trial.task);
		if (!held || (held.outcome === "unscored" && trial.outcome !== "unscored")) byTask.set(trial.task, trial);
	}
	return byTask;
}

/** 精确 McNemar：只看两边结果不同的题，零假设下各占一半。 */
function mcnemar(onlyA: number, onlyB: number): number {
	const n = onlyA + onlyB;
	if (n === 0) return 1;
	let tail = 0;
	let choose = 1;
	for (let k = 0; k <= Math.min(onlyA, onlyB); k++) {
		tail += choose;
		choose = (choose * (n - k)) / (k + 1);
	}
	return Math.min(1, (2 * tail) / 2 ** n);
}

const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "-");

const jobs = process.argv.slice(2);
if (jobs.length === 0) {
	console.error("用法：pnpm bench:summary <job> [<job>...]");
	process.exit(2);
}

const arms = new Map<string, Trial[]>();
for (const job of jobs) {
	const { arm, trials } = readJob(job);
	if (arm) arms.set(arm, [...(arms.get(arm) ?? []), ...trials]);
}

const settled = [...arms].map(([arm, trials]) => ({ arm, tasks: settle(trials), attempts: trials.length }));
const lines: string[] = [];
for (const { arm, tasks, attempts } of settled) {
	const all = [...tasks.values()];
	const scored = all.filter((trial) => trial.outcome !== "unscored");
	const passed = scored.filter((trial) => trial.outcome === "passed").length;
	const cost = [...(arms.get(arm) ?? [])].reduce((sum, trial) => sum + trial.cost, 0);
	const unscored = all.filter((trial) => trial.outcome === "unscored").map((trial) => trial.task).sort();
	lines.push(arm);
	lines.push(`  通过 ${passed}/${scored.length}（${percent(passed, scored.length)}）· 超时 ${scored.filter((trial) => trial.timedOut).length} · 未判分 ${unscored.length} · 共 ${all.length} 道、${attempts} 次运行`);
	lines.push(`  花费 $${cost.toFixed(2)}（含重跑）· 每过一道 $${passed ? (cost / passed).toFixed(3) : "-"}`);
	if (unscored.length) lines.push(`  未判分，重跑：-- ${unscored.map((task) => `-i ${task}`).join(" ")}`);
	lines.push("");
}

if (settled.length === 2) {
	const [a, b] = settled;
	const both = [...a.tasks.keys()].filter((task) => a.tasks.get(task)?.outcome !== "unscored" && b.tasks.has(task) && b.tasks.get(task)?.outcome !== "unscored").sort();
	const pass = (side: typeof a, task: string) => side.tasks.get(task)?.outcome === "passed";
	const onlyA = both.filter((task) => pass(a, task) && !pass(b, task));
	const onlyB = both.filter((task) => !pass(a, task) && pass(b, task));
	const name = (side: typeof a) => side.arm.split(" ")[0];
	lines.push(`配对：两边都判了分的 ${both.length} 道`);
	lines.push(`  ${name(a)} ${both.filter((task) => pass(a, task)).length} · ${name(b)} ${both.filter((task) => pass(b, task)).length} · 只有 ${name(a)} 过 ${onlyA.length} · 只有 ${name(b)} 过 ${onlyB.length} · McNemar p=${mcnemar(onlyA.length, onlyB.length).toFixed(3)}`);
	if (onlyA.length) lines.push(`  只有 ${name(a)} 过：${onlyA.join(" ")}`);
	if (onlyB.length) lines.push(`  只有 ${name(b)} 过：${onlyB.join(" ")}`);
}

process.stdout.write(`${lines.join("\n")}\n`);
