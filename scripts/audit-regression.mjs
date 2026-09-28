/**
 * 这次审计整改修过的每一条，各自的守卫跑一遍。
 *
 * 为什么要有这个文件：整改摊在十几个提交里，每一条都配了测试，但那些测试散在七个包的 `test/`
 * 下面。`pnpm test` 全绿只说明「三千八百条里没有红的」，说不出「C1 那五个工具还在吗」——而问
 * 「那一条还在吗」才是回归测试要回答的问题。这里把问题和守它的东西写成一张表，跑完逐条报。
 *
 * 一条没有守卫的修复等于没修：下一个人重构到那里，没有任何东西会告诉他。所以这张表也是一份
 * 检查——某条修复在这里找不到守卫，那是需要补测试，不是需要放过。
 *
 * 用法：
 *   node scripts/audit-regression.mjs          单测与门禁，约一分钟，不弹窗口
 *   node scripts/audit-regression.mjs --window  再加上要真窗口的那几条（会抢焦点几分钟）
 *
 * 真窗口那几条默认不跑，理由是它们会把窗口摆到屏幕上抢焦点，而其中依赖真实指针位置的探针在
 * 人正在用电脑时结果不可信（`screenshot-probe` 实测在 1 到 11 个问题之间跳，基线同样跳）。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withWindow = process.argv.includes("--window");

/**
 * 一条修复，和证明它还在的那个东西。
 *
 * `id` 是审计报告里的编号，`what` 是当初错在哪——写成「症状」而不是「改了什么」，因为回归的时候
 * 人看见的是症状。
 */
const CHECKS = [
	{
		id: "context-assembly",
		what: "上下文统计偏离实际请求、重启后重读已变更规则、固定前缀缺少预算",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/context-assembly.test.ts"]],
	},
	{
		id: "edit-safety",
		what: "重叠操作吞内容、编辑开放未读行、过期版本绕过、文本保真与并发写入保护",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/edit-safety.test.ts"]],
	},
	{
		id: "edit-diff",
		what: "相隔很远的两处修改分配全文件矩阵，造成耗时与内存膨胀",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/diff.test.ts"]],
	},
	{
		id: "ISSUE-cost-loop",
		what: "大结果无限携带、未完成清单强制续跑、技能重复注入及空回复重试重置",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/aged-prune.test.ts", "packages/core/test/stale-results.test.ts", "packages/core/test/prune-timing.test.ts", "packages/core/test/prune-live-session.test.ts", "packages/core/test/read-long-line.test.ts", "packages/core/test/long-line.test.ts", "packages/core/test/context.test.ts", "packages/core/test/grep-literal.test.ts", "packages/core/test/nudge.test.ts", "packages/core/test/repetition.test.ts", "packages/core/test/translated-tools.test.ts", "packages/core/test/skill-allowed-tools.test.ts", "packages/core/test/session-log.test.ts", "packages/core/test/resume.test.ts"]],
	},
	{
		id: "ISSUE-question",
		what: "Full Access 混淆回答与权限、跳过和多选缺少可信边界校验",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/ask-user.test.ts"]],
	},
	{
		id: "ISSUE-ui",
		what: "提问遮挡、清单残留、队列卸载重建、过程收起硬切和 Git 重复入口",
		run: ["pnpm", ["--filter", "@plume/desktop", "exec", "node", "--import", "tsx", "--import", "./test/helpers/dom.ts", "--import", "./test/helpers/assets.mjs", "--test", "test/ui/approval-overlay.test.ts", "test/ui/message-queue-strip.test.ts", "test/ui/turn-process.test.ts", "test/ui/git-group-actions.test.ts"]],
	},
	{
		id: "C1",
		what: "recall/learn/lsp/web_search 等工具没被告知给模型",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/tool-registry.test.ts"]],
	},
	{
		id: "S2",
		what: "压缩缝只转四个参数，桌面端丢了 overhead/artifacts/summarizer",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/compaction-seam.test.ts", "packages/core/test/compaction-outline.test.ts", "packages/core/test/task-context.test.ts", "packages/core/test/context-budget.test.ts", "packages/core/test/compaction-recovery.test.ts", "packages/core/test/auto-compaction.test.ts", "packages/core/test/files-already-seen.test.ts"]],
	},
	{
		id: "S1",
		what: "主进程的 ipcMain.handle 没有任何东西和契约比对",
		run: ["pnpm", ["--filter", "@plume/contract", "test"]],
	},
	{
		id: "H1",
		what: "命令分类器的七条绕过（env 包装、bash -c、git 全局选项、长选项、任意解释器管道、双引号里的 $()、换行）",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/risk-bypass.test.ts", "packages/core/test/risk.test.ts"]],
	},
	{
		id: "H2",
		what: "密钥读侧无审批，以及沙箱网络轴配了传不下去",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/sandbox-bash.test.ts"]],
	},
	{
		id: "ISSUE-escalate",
		what: "auto 模式下提权不问人就到沙箱外跑（策略判的是 escalate:…: 前缀串，认不出程序，rm -rf 也放行）",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/escalation-gate.test.ts", "packages/core/test/escalation.test.ts"]],
	},
	{
		id: "ISSUE-escalate-always",
		what: "提权卡片点了「以后不再问」，同样的提权从此在任何模式下都不问人就到沙箱外跑",
		run: ["node", ["--test", "--import", "./packages/desktop/test/setup.ts", "--experimental-strip-types", "packages/core/test/escalation-gate.test.ts", "packages/desktop/test/approval-response.test.ts"]],
	},
	{
		id: "S3",
		what: "Anthropic 把半截流当完整回答；空闲闸只挂在一条链上",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/anthropic-truncated-stream.test.ts", "packages/core/test/anthropic-wire-stream.test.ts"]],
	},
	{
		id: "I3",
		what: "YAML 解析失败时把解析器的原话丢了",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/skill-frontmatter.test.ts"]],
	},
	{
		id: "CORE-protocol",
		what: "三条协议链：自学习查表键错位、服务端等待时间不生效、拒绝/截断的结束原因、计费档位、429 误判、并行工具调用合并",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/adapter-protocol-fixes.test.ts", "packages/core/test/retry-policy.test.ts"]],
	},
	{
		id: "CORE-cache-usage",
		what: "第三方服务商的缓存命中/写入字段认不出，命中记成 0、按全价计费；缓存路由键不带或被拒后不会撤",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/usage-fields.test.ts", "packages/core/test/cache-routing.test.ts"]],
	},
	{
		id: "CORE-view",
		what: "发给模型的视图与下一轮重建不一致：剪枝不落盘、摘要丢工具参数、大结果首发被剪而 read 记成已读、重复读取原文消失",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/prune-view-persistence.test.ts", "packages/core/test/compaction-condense.test.ts", "packages/core/test/read-output-budget.test.ts", "packages/core/test/repeat-keeps-original.test.ts"]],
	},
	{
		id: "CORE-overflow",
		what: "上下文超长只剪大工具输出，没东西可剪时会话卡死；被拒回复先落盘让压缩边界数偏",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/context-overflow.test.ts"]],
	},
	{
		id: "CORE-prompt-freeze",
		what: "技能/AGENTS.md/推理档位一变就重写 system prompt，整条缓存前缀失效；记忆每次 learn 都改开头",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/prompt-freeze.test.ts", "packages/core/test/memory-snapshot.test.ts"]],
	},
	{
		id: "CORE-lifecycle",
		what: "停止后排队的子代理照跑、孙代理不停、第 200 轮插话丢失、任务队列竞态、续跑换模型旧句柄",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/dispatch-guard.test.ts", "packages/core/test/sub-agent-lineage.test.ts", "packages/core/test/sub-agent-resume.test.ts", "packages/core/test/steer-at-turn-cap.test.ts", "packages/core/test/task-queue-between.test.ts", "packages/core/test/revert-message.test.ts"]],
	},
	{
		id: "CORE-tools",
		what: "宿主 git 执行仓库配置里的程序、bash 输出反复截断、web_fetch 重绑定、搜索截断不告知、MCP 顺序与上限、完全访问加断网变只读",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/file-changes.test.ts", "packages/core/test/bash-output.test.ts", "packages/core/test/web-fetch.test.ts", "packages/core/test/glob-truncation.test.ts", "packages/core/test/mcp-client.test.ts", "packages/core/test/sandbox-policy.test.ts"]],
	},
	{
		id: "CORE-cache-diagnostics",
		what: "前缀被打断只能人看累计命中率，定位不到是哪一次请求",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/cache-diagnostics.test.ts"]],
	},
	{
		id: "CORE-index-writes",
		what: "每追加一条记录都整份重写会话索引",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/session-index-writes.test.ts"]],
	},
	{
		id: "I4-worktree",
		what: "删工作树失败后无条件 rm -rf，而那个 IPC 没有路径守卫",
		run: ["node", ["--test", "--import", "./packages/desktop/test/setup.ts", "--experimental-strip-types", "packages/desktop/test/git-worktrees.test.ts"]],
	},
	{
		id: "I1-i18n",
		what: "i18n 检查器的两个盲点（字符串里的 // 当注释、JSX 文本遇 > 就断）",
		run: ["node", ["--experimental-strip-types", "--test", "test/check-i18n.test.ts"]],
	},
	{
		id: "I1-scan",
		what: "硬编码中文（那四条漏网的）",
		run: ["node", ["scripts/check-i18n.mjs"]],
	},
	{
		id: "I2",
		what: "文档里七处过期数字",
		run: ["node", ["--experimental-strip-types", "--test", "test/docs-numbers.test.ts"]],
	},
	{
		id: "S5+I4-arch",
		what: "循环依赖没有棘轮；store 伸进功能域点名文件没人管",
		run: ["pnpm", ["arch"]],
	},
	{
		id: "S6",
		what: "十一条 React 编译器规则整块关掉且没有理由",
		run: ["pnpm", ["lint"]],
	},
	{
		id: "knip",
		what: "191 个未用导出，而 CI 里那条检查永远不会红",
		run: ["pnpm", ["knip"]],
	},
	{
		id: "harness-context",
		what: "重试用量被当成窗口占用、多块结果与摘要输入绕过总预算、仅剪枝足够仍调摘要、大纲读取清掉读过的正文、recall 不返回命中处、测图计数硬停真实工作",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/retry-usage-context.test.ts", "packages/core/test/prune-total.test.ts", "packages/core/test/compaction-budget.test.ts", "packages/core/test/stale-results.test.ts", "packages/core/test/recall.test.ts", "packages/core/test/repetition.test.ts"]],
	},
	{
		id: "harness-core",
		what: "崩溃留下的半行吞掉下一条记录、撤回到压缩边界丢了边界、输出上限截断当成说完了、Anthropic 起始帧自带的内容和空白文本块、撤回后被截掉的后台子代理照样送回结果",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/store.test.ts", "packages/core/test/output-limit.test.ts", "packages/core/test/anthropic-wire-content.test.ts", "packages/core/test/delegation-detach.test.ts"]],
	},
	{
		id: "harness-low",
		what: "带工具调用却报 stop、回放坏参数、限流等待与 Gemini 每分钟限额、推理摘要粘连、压缩剪过的视图重启后丢失、单独清单提示写盘后才接上、并行 learn 互相覆盖、钩子替人批提权",
		run: ["node", ["--experimental-strip-types", "--test", "packages/core/test/cc-wire-stream.test.ts", "packages/core/test/cc-wire-request.test.ts", "packages/core/test/failure-classify.test.ts", "packages/core/test/retry.test.ts", "packages/core/test/responses-lossy-stream.test.ts", "packages/core/test/prune-view-persistence.test.ts", "packages/core/test/todo-solo-nudge.test.ts", "packages/core/test/project-memory.test.ts", "packages/core/test/hooks.test.ts"]],
	},
	{
		id: "S7-annotate",
		what: "标注拆成三个文件之后还画得出来吗",
		window: true,
		run: ["node", ["--experimental-strip-types", "packages/desktop/e2e/annotator-probe.ts", "/tmp/regression-annot"]],
	},
	{
		id: "S7-capture",
		what: "截图浮层拆出两个 hook 之后，退出与连续两次捕获还对吗",
		window: true,
		run: ["node", ["--experimental-strip-types", "packages/desktop/e2e/screenshot-exit-probe.ts", "/tmp/regression-exit"]],
	},
	{
		id: "ISSUE-escalate-always-window",
		what: "跑起来的桌面端里，提权卡片还有「以后不再问」吗；设置里旧版本记下的那条还替人答吗",
		window: true,
		run: ["node", ["--experimental-strip-types", "packages/desktop/e2e/escalation-approval-probe.ts", "/tmp/regression-escalate"]],
	},
	{
		id: "C1-window",
		what: "那五个工具在跑起来的桌面端里真的出现在工具清单上吗",
		window: true,
		run: ["node", ["--experimental-strip-types", "packages/desktop/e2e/audit-fixes-demo.ts", "/tmp/regression-tools"]],
	},
];

const pass = [];
const fail = [];
const skipped = [];

for (const check of CHECKS) {
	if (check.window && !withWindow) {
		skipped.push(check);
		continue;
	}
	const [cmd, args] = check.run;
	process.stdout.write(`  ${check.id} … `);
	const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const ok = result.status === 0;
	(ok ? pass : fail).push({ ...check, output: `${result.stdout ?? ""}${result.stderr ?? ""}` });
	console.log(ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m");
}

console.log("");
for (const check of pass) console.log(`\x1b[32m✓\x1b[0m ${check.id.padEnd(14)} ${check.what}`);
for (const check of skipped) console.log(`\x1b[33m—\x1b[0m ${check.id.padEnd(14)} ${check.what}（要真窗口，加 --window）`);
for (const check of fail) {
	console.log(`\n\x1b[31m✗ ${check.id}\x1b[0m ${check.what}`);
	// 尾部够看出哪条断言红了，而不是把一整份测试输出倒出来。
	console.log(
		check.output
			.split("\n")
			.filter((line) => line.trim())
			.slice(-14)
			.map((line) => `    ${line}`)
			.join("\n"),
	);
}

console.log(
	`\n${fail.length === 0 ? "\x1b[32m" : "\x1b[31m"}${pass.length} 条守住，${fail.length} 条回归${
		skipped.length ? `，${skipped.length} 条没跑` : ""
	}\x1b[0m`,
);
process.exitCode = fail.length === 0 ? 0 : 1;
