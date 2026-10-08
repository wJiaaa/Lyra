import { ScrollView, Text, View } from "react-native";
import type { Step } from "./feed.ts";
import { Sheet } from "./Sheet.tsx";
import { CopyButton } from "./copy.tsx";
import { diffStat, toolPath, toolSubject, toolVerb, type Todo } from "./tools.ts";
import { Icon, Txt, mono, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

interface Hunk { oldStart: number; newStart: number; lines: { type: "context" | "add" | "remove"; text: string }[] }
/** 一屏 diff 再长也翻不完；超过的部分去电脑上看，手机不为它卡顿。 */
const MAX_DIFF_LINES = 800;
const MAX_TEXT = 20_000;

function Section({ label, copy, children, t }: { label: string; copy?: string; children: React.ReactNode; t: T }) {
	return <View style={{ gap: 8 }}>
		<View style={{ flexDirection: "row", alignItems: "center", minHeight: 24 }}>
			<Txt kind="eyebrow" tone="faint" style={{ flex: 1 }}>{label}</Txt>
			{copy !== undefined && <CopyButton text={copy} label={t("copy")} copiedLabel={t("copied")} />}
		</View>
		{children}
	</View>;
}

function Mono({ text, tone }: { text: string; tone?: string }) {
	const theme = useTheme();
	return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: 12, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 12 }}>
		<Text selectable style={{ fontSize: 12, lineHeight: 18, color: tone ?? theme.ink, fontFamily: mono }}>{text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text}</Text>
	</ScrollView>;
}

/** 改动按行着色，左边一列 +/−。不排行号：手机宽度只够放代码，行号是在电脑上对位置用的。 */
function Diff({ hunks }: { hunks: Hunk[] }) {
	const theme = useTheme();
	let budget = MAX_DIFF_LINES;
	return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: 12, backgroundColor: theme.bg }} contentContainerStyle={{ paddingVertical: 6, minWidth: "100%" }}>
		<View style={{ minWidth: "100%" }}>
			{hunks.map((hunk, index) => {
				const lines = hunk.lines.slice(0, Math.max(0, budget));
				budget -= lines.length;
				if (!lines.length) return null;
				return <View key={index}>
					<Text style={{ fontFamily: mono, fontSize: 11, lineHeight: 20, color: theme.faint, paddingHorizontal: 12 }}>{`@@ -${hunk.oldStart} +${hunk.newStart} @@`}</Text>
					{lines.map((line, row) => <View key={row} style={{ flexDirection: "row", paddingRight: 12, backgroundColor: line.type === "add" ? theme.successSoft : line.type === "remove" ? theme.dangerSoft : "transparent" }}>
						<Text style={{ width: 22, textAlign: "center", fontFamily: mono, fontSize: 12, lineHeight: 18, color: line.type === "add" ? theme.success : line.type === "remove" ? theme.danger : theme.faint }}>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</Text>
						<Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: line.type === "context" ? theme.muted : theme.ink }}>{line.text || " "}</Text>
					</View>)}
				</View>;
			})}
		</View>
	</ScrollView>;
}

export function TodoList({ todos }: { todos: Todo[] }) {
	const theme = useTheme();
	return <View style={{ gap: 2 }}>
		{todos.map((todo, index) => {
			const done = todo.status === "completed";
			const active = todo.status === "in_progress";
			return <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 7 }}>
				<View style={{ paddingTop: 2 }}><Icon name={done ? "check-circle" : active ? "disc" : "circle"} size={16} color={done ? theme.success : active ? theme.accent : theme.faint} /></View>
				<Text style={{ flex: 1, fontSize: 15, lineHeight: 21, color: done ? theme.muted : theme.ink, textDecorationLine: done ? "line-through" : "none", fontWeight: active ? "600" : "400" }}>{active && todo.activeForm ? todo.activeForm : todo.content}</Text>
			</View>;
		})}
	</View>;
}

/** 去掉已经在别处出现过的大段参数（编辑的新旧文本、整份清单），剩下的才值得当「输入」看。 */
function inputText(step: Step): string {
	if (!step.args || typeof step.args !== "object") return JSON.stringify(step.args ?? null, null, 2);
	const rest = Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}…` : value]));
	return JSON.stringify(rest, null, 2);
}

/** 一步收尾时值得一提的状态：中断、退出码、失败。成功又没有退出码就什么都不说。 */
function statusOf(step: Step, running: boolean, t: T): { label: string; bad: boolean } | null {
	if (!step.done) return running ? null : { label: t("stopped"), bad: true };
	const exit = (step.details as { exitCode?: unknown } | undefined)?.exitCode;
	if (typeof exit === "number") return { label: t("exitCode", { n: exit }), bad: step.failed || exit !== 0 };
	return step.failed ? { label: t("failed"), bad: true } : null;
}

function Badge({ label, bad }: { label: string; bad: boolean }) {
	const theme = useTheme();
	return <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, height: 24, borderRadius: 12, backgroundColor: bad ? theme.dangerSoft : theme.card }}>
		<Icon name={bad ? "alert-circle" : "check"} size={12} color={bad ? theme.danger : theme.muted} />
		<Text style={{ fontSize: 12, color: bad ? theme.danger : theme.muted, fontWeight: "500" }}>{label}</Text>
	</View>;
}

/** 改了几行。为零的那一侧不写：「+3 −0」里的 −0 读起来像是删了什么。 */
export function DiffStat({ stat }: { stat: { added: number; removed: number } | null }) {
	const theme = useTheme();
	if (!stat || (!stat.added && !stat.removed)) return null;
	return <Text style={{ fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
		{stat.added > 0 && <Text style={{ color: theme.success }}>+{stat.added}</Text>}
		{stat.added > 0 && stat.removed > 0 && " "}
		{stat.removed > 0 && <Text style={{ color: theme.danger }}>−{stat.removed}</Text>}
	</Text>;
}

/**
 * 一步的详情，从底部升起。按工具换形态：改文件看 diff，跑命令看终端，更新清单看清单；
 * 其余的给输入和输出原文。手机上展开在列表里会把对话顶出屏幕，所以放进面板。
 */
export function ToolSheet({ step, running, close, t }: { step: Step; running: boolean; close(): void; t: T }) {
	const theme = useTheme();
	const path = toolPath(step.name, step.args);
	const hunks = (step.details as { hunks?: Hunk[] } | undefined)?.hunks;
	const stat = diffStat(step.details);
	const command = step.name === "bash" ? (step.args as { command?: string } | undefined)?.command : undefined;
	const todos = step.name === "todo_write" ? (step.args as { todos?: Todo[] } | undefined)?.todos : undefined;
	const output = step.output?.trim() ?? "";
	const subject = toolSubject(step.name, step.args);
	// 路径只在比标题多说了点什么时才写；`README.md` 标题里已经有了。
	const where = path && path !== subject ? path : "";
	const status = statusOf(step, running, t);
	return <Sheet title={subject ? `${toolVerb(step.name, t)} ${subject}` : toolVerb(step.name, t)} close={close} closeLabel={t("close")} tall>
		<ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 18 }}>
			{(where || stat || status) && <View style={{ gap: 8 }}>
				{!!where && <Text selectable style={{ color: theme.muted, fontSize: 12, fontFamily: mono }}>{where}</Text>}
				{(stat || status) && <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
					<DiffStat stat={stat} />
					{status && <Badge {...status} />}
				</View>}
			</View>}
			{hunks?.length ? <Diff hunks={hunks} />
				: command !== undefined ? <Section label={t("toolBash")} copy={command} t={t}>
					<View style={{ borderRadius: 12, backgroundColor: theme.bg, padding: 12, gap: 8 }}>
						<Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: theme.strong }}><Text style={{ color: theme.success }}>$ </Text>{command}</Text>
						{step.done && <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: step.failed ? theme.danger : theme.muted }}>{(output || t("noOutput")).slice(0, MAX_TEXT)}</Text>}
					</View>
				</Section>
				: todos ? <TodoList todos={todos} />
				: <>
					<Section label={t("input")} copy={inputText(step)} t={t}><Mono text={inputText(step)} /></Section>
					{step.done && <Section label={t("output")} copy={output} t={t}><Mono text={output || t("noOutput")} tone={step.failed ? theme.danger : undefined} /></Section>}
				</>}
		</ScrollView>
	</Sheet>;
}
