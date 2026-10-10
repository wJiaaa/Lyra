/**
 * 回复里的 ```ui 块，在手机上画成它描述的样子——只读。
 *
 * 以前这里是一张代码块：一屏 `<Grid cols={3}><Stat …>` 的源码，在手机上等于什么也没说。现在排版、文字、
 * 数字、表、图都画出来；能改的东西（输入框、选项、滑块、开关）只写出它现在的值，按钮不画，块底下一行
 * 字说明要回电脑上操作。手机发出去的话还带不上块里设的值、气泡也没法只显示按钮上那几个字，假装能按
 * 比不画更糟。读块的规则和桌面是同一份（`@plume/client-runtime/ui-language`）。
 *
 * 值是块自己的初值：人在桌面上改过什么，存在那台电脑的窗口里，手机读不到。
 */

import { Component, Fragment, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { COMPONENTS, evaluate, initialState, parseBlock, readProps, text, type UiElement, type UiNode } from "@plume/client-runtime/ui-language";
import { chartView, gridColumns, tableMarkdown, tableOf, type TableData } from "./interface-data.ts";
import { useTheme, type Palette } from "./ui.tsx";
import type { T } from "./i18n.ts";

const GAP: Record<string, number> = { sm: 6, md: 10, lg: 16 };
const gapOf = (gap: unknown) => GAP[String(gap ?? "md")] ?? GAP.md!;
/** 再多的行一段回复也装不下，`Each` 到这里为止，和桌面同一个数。 */
const MAX_REPEAT = 200;
const CONTROLS = new Set(["Input", "Select", "Choice", "Slider", "Toggle", "Button"]);
const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

function toneColor(theme: Palette, tone: unknown): { ink: string; soft: string } {
	if (tone === "ok") return { ink: theme.success, soft: theme.successSoft };
	if (tone === "warning") return { ink: theme.warning, soft: theme.warningSoft };
	if (tone === "danger") return { ink: theme.danger, soft: theme.dangerSoft };
	return { ink: theme.accent, soft: theme.accentSoft };
}

interface Scope {
	values: Readonly<Record<string, unknown>>;
	set: (values: Record<string, unknown>) => void;
	depth: number;
	theme: Palette;
	t: T;
	table: (markdown: string) => ReactNode;
}

function words(nodes: UiNode[], values: Readonly<Record<string, unknown>>): string {
	return nodes.map((node) => (node.kind === "text" ? node.parts.map((part) => (typeof part === "string" ? part : part.expression ? text(evaluate(part.expression, values)) : "")).join("") : "")).join("");
}

function hasControls(nodes: UiNode[]): boolean {
	return nodes.some((node) => node.kind === "element" && (CONTROLS.has(node.name) || hasControls(node.children)));
}

function renderNodes(nodes: UiNode[], scope: Scope): ReactNode[] {
	return nodes.map((node, index) => {
		if (node.kind === "element") return <Fragment key={index}>{renderElement(node, scope)}</Fragment>;
		const said = words([node], scope.values).trim();
		return said ? <Text key={index} selectable style={{ color: scope.theme.ink, fontSize: 15, lineHeight: 22 }}>{said}</Text> : null;
	});
}

function Grid({ cols, gap, children }: { cols: number | undefined; gap: number; children: ReactNode[] }) {
	const [width, setWidth] = useState(0);
	const count = width ? gridColumns(cols, width, gap) : 1;
	const cell = width ? (width - gap * (count - 1)) / count : undefined;
	return <View onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))} style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
		{children.map((child, at) => <View key={at} style={cell ? { width: cell } : { width: "100%" }}>{child}</View>)}
	</View>;
}

function Tabs({ titles, value, onChange, render, theme }: { titles: string[]; value?: string; onChange?: (title: string) => void; render: (at: number) => ReactNode; theme: Palette }) {
	const [own, setOwn] = useState(titles[0] ?? "");
	const at = Math.max(0, titles.indexOf(value ?? own));
	if (!titles.length) return null;
	return <View style={{ gap: 10 }}>
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 2, padding: 2, borderRadius: 9, backgroundColor: theme.card }} style={{ flexGrow: 0, alignSelf: "flex-start" }}>
			{titles.map((title, index) => <Pressable key={index} accessibilityRole="tab" accessibilityState={{ selected: index === at }} onPress={() => (onChange ?? setOwn)(title)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 7, backgroundColor: index === at ? theme.elevated : "transparent" }}>
				<Text style={{ color: index === at ? theme.strong : theme.muted, fontSize: 13, lineHeight: 18, fontWeight: index === at ? "600" : "400" }}>{title}</Text>
			</Pressable>)}
		</ScrollView>
		{render(at)}
	</View>;
}

/** 输入类控件只写出现在的值：一行，左边是它叫什么，右边是值。 */
function Value({ label, value, theme, faint = false }: { label?: string; value: string; theme: Palette; faint?: boolean }) {
	return <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12, paddingVertical: 2 }}>
		{label ? <Text style={{ flex: 1, color: theme.muted, fontSize: 13, lineHeight: 19 }}>{label}</Text> : null}
		<Text selectable style={[{ flexShrink: 1, color: faint ? theme.faint : theme.strong, fontSize: 15, lineHeight: 21, fontWeight: "500", textAlign: label ? "right" : "left" }, tabular]}>{value || "—"}</Text>
	</View>;
}

/** 选项的显示名：字符串本身，或 `{label, value}` 里的 label。 */
function optionLabel(options: unknown[] | undefined, value: unknown): string {
	const found = (options ?? []).find((option) => (option && typeof option === "object" ? (option as { value?: unknown }).value : option) === value);
	return found && typeof found === "object" ? text((found as { label?: unknown }).label ?? (found as { value?: unknown }).value) : text(found ?? value);
}

function Chart({ kind, data, x, y, unit, scope }: { kind?: string; data?: unknown[]; x?: string; y?: unknown; unit?: string; scope: Scope }) {
	const view = chartView(kind, data, x, y);
	const theme = scope.theme;
	if (!view) return null;
	if (view.kind === "table") return scope.table(tableMarkdown(view.table));
	return <View style={{ gap: 8 }} accessibilityLabel={view.series}>
		{view.bars.map((bar, at) => <View key={at} style={{ gap: 4 }}>
			<View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
				<Text numberOfLines={1} style={{ flex: 1, color: theme.muted, fontSize: 13, lineHeight: 18 }}>{bar.label}</Text>
				<Text style={[{ color: theme.ink, fontSize: 13, lineHeight: 18 }, tabular]}>{`${text(bar.value)}${unit ?? ""}${bar.share !== undefined ? ` · ${Math.round(bar.share * 100)}%` : ""}`}</Text>
			</View>
			{/* 不铺底槽：带槽的细条是 `Progress`，图表的条和它长一样，就读成了四个进度。 */}
			<View style={{ width: `${Math.max(bar.value ? 1 : 0, bar.length * 100)}%`, height: 10, borderRadius: 3, backgroundColor: bar.value < 0 ? theme.danger : theme.accent }} />
		</View>)}
	</View>;
}

function renderElement(element: UiElement, scope: Scope): ReactNode {
	if (!COMPONENTS[element.name]) return null;
	const props = readProps(element, scope.values);
	if ("when" in element.props && !props.when) return null;
	const { theme, t } = scope;
	const inner = (next: Scope = scope) => renderNodes(element.children, next);
	const said = () => words(element.children, scope.values).trim();
	const tone = toneColor(theme, props.tone);
	const value = (name: unknown) => scope.values[String(name)];

	switch (element.name) {
		case "Stack":
		case "Tab":
			return <View style={{ gap: gapOf(props.gap) }}>{inner()}</View>;
		case "Row": {
			const justify = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" } as const;
			return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: gapOf(props.gap), justifyContent: justify[props.align as keyof typeof justify] ?? "flex-start" }}>{inner()}</View>;
		}
		case "Grid":
			return <Grid cols={props.cols as number | undefined} gap={gapOf(props.gap)}>{inner()}</Grid>;
		case "Card": {
			const nested = scope.depth > 0;
			return <View style={[{ gap: 10 }, nested ? { padding: 12, borderRadius: 10, backgroundColor: theme.card } : { padding: 14, borderRadius: 14, backgroundColor: theme.grouped, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line }]}>
				{props.title || props.subtitle ? <View style={{ gap: 2 }}>
					{props.title ? <Text style={{ color: theme.strong, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>{text(props.title)}</Text> : null}
					{props.subtitle ? <Text style={{ color: theme.muted, fontSize: 13, lineHeight: 18 }}>{text(props.subtitle)}</Text> : null}
				</View> : null}
				{inner({ ...scope, depth: scope.depth + 1 })}
			</View>;
		}
		case "Divider":
			return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />;
		case "Tabs": {
			const tabs = element.children.filter((child): child is UiElement => child.kind === "element" && child.name === "Tab");
			const name = props.name as string | undefined;
			return <Tabs theme={theme} titles={tabs.map((tab) => text(readProps(tab, scope.values).title ?? ""))} value={name ? text(scope.values[name]) : undefined} onChange={name ? (title) => scope.set({ [name]: title }) : undefined} render={(at) => <View style={{ gap: 10 }}>{renderNodes(tabs[at]?.children ?? [], scope)}</View>} />;
		}
		case "Each": {
			const items = ((props.of as unknown[] | undefined) ?? []).slice(0, MAX_REPEAT);
			const as = (props.as as string | undefined) || "item";
			const index = props.index as string | undefined;
			return items.map((item, at) => <Fragment key={at}>{inner({ ...scope, values: { ...scope.values, [as]: item, ...(index ? { [index]: at } : {}) } })}</Fragment>);
		}
		case "Heading": {
			const level = Math.min(3, Math.max(1, Math.round((props.level as number | undefined) ?? 2)));
			const style = [{ fontSize: 18, lineHeight: 24, fontWeight: "700" as const, color: theme.strong }, { fontSize: 16, lineHeight: 22, fontWeight: "600" as const, color: theme.strong }, { fontSize: 13, lineHeight: 18, fontWeight: "500" as const, color: theme.muted }][level - 1];
			return <Text accessibilityRole="header" selectable style={style}>{said()}</Text>;
		}
		case "Text": {
			const size = { sm: [13, 19], md: [15, 22], lg: [18, 25] }[String(props.size ?? "md")] ?? [15, 22];
			const colour = props.tone === "muted" ? theme.muted : props.tone === "strong" ? theme.strong : props.tone ? tone.ink : theme.ink;
			return <Text selectable style={{ color: colour, fontSize: size[0], lineHeight: size[1], fontWeight: props.tone === "strong" ? "500" : "400" }}>{said()}</Text>;
		}
		case "Badge":
			return <View style={{ alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: props.tone ? tone.soft : theme.card }}>
				<Text style={{ color: props.tone ? tone.ink : theme.muted, fontSize: 12, lineHeight: 17 }}>{said()}</Text>
			</View>;
		case "Callout":
			return <View style={{ gap: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderLeftWidth: 2, borderLeftColor: tone.ink, backgroundColor: tone.soft }}>
				{props.title ? <Text style={{ color: tone.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{text(props.title)}</Text> : null}
				<View style={{ gap: 4 }}>{inner()}</View>
			</View>;
		case "Stat": {
			const change = props.delta === undefined ? "" : typeof props.delta === "number" ? `${props.delta > 0 ? "+" : ""}${props.delta}` : text(props.delta);
			const lead = change.trim()[0];
			const way = lead === "+" || lead === "↑" ? theme.success : lead === "-" || lead === "−" || lead === "↓" ? theme.danger : theme.muted;
			return <View style={{ gap: 2 }}>
				<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12, lineHeight: 17 }}>{text(props.label)}</Text>
				<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 }}>
					<Text selectable style={[{ color: theme.strong, fontSize: 22, lineHeight: 28, fontWeight: "600" }, tabular]}>{text(props.value)}</Text>
					{change ? <Text style={[{ color: way, fontSize: 13, lineHeight: 18 }, tabular]}>{change}</Text> : null}
				</View>
				{props.hint ? <Text style={{ color: theme.faint, fontSize: 12, lineHeight: 17 }}>{text(props.hint)}</Text> : null}
			</View>;
		}
		case "Progress": {
			const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
			const share = Math.min(1, Math.max(0, ((props.value as number | undefined) ?? 0) / max));
			return <View style={{ gap: 5 }}>
				<View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
					<Text numberOfLines={1} style={{ flex: 1, color: theme.muted, fontSize: 13, lineHeight: 18 }}>{text(props.label ?? "")}</Text>
					<Text style={[{ color: theme.ink, fontSize: 13, lineHeight: 18 }, tabular]}>{`${Math.round(share * 100)}%`}</Text>
				</View>
				<View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max, now: (props.value as number | undefined) ?? 0 }} style={{ height: 6, borderRadius: 3, backgroundColor: theme.line, overflow: "hidden" }}>
					<View style={{ width: `${share * 100}%`, height: "100%", borderRadius: 3, backgroundColor: props.tone ? tone.ink : theme.accent }} />
				</View>
			</View>;
		}
		case "Table": {
			const table: TableData | null = tableOf(props.columns as unknown[] | undefined, props.rows as unknown[] | undefined, props.data as unknown[] | undefined);
			return table ? scope.table(tableMarkdown(table)) : null;
		}
		case "Chart":
			return <Chart kind={props.kind as string | undefined} data={props.data as unknown[] | undefined} x={props.x as string | undefined} y={props.y} unit={props.unit as string | undefined} scope={scope} />;
		case "Input":
			return <Value theme={theme} label={text(props.label ?? "")} value={text(value(props.name)) || text(props.placeholder ?? "")} faint={!text(value(props.name))} />;
		case "Select":
		case "Choice": {
			const chosen = value(props.name);
			const options = props.options as unknown[] | undefined;
			return <Value theme={theme} label={text(props.label ?? "")} value={(Array.isArray(chosen) ? chosen : chosen === undefined ? [] : [chosen]).map((item) => optionLabel(options, item)).join(t("listSep"))} />;
		}
		case "Slider":
			return <Value theme={theme} label={text(props.label ?? "")} value={`${text(value(props.name))}${text(props.unit ?? "")}`} />;
		case "Toggle":
			return <Value theme={theme} label={text(props.label ?? "")} value={t(value(props.name) === true ? "interfaceOn" : "interfaceOff")} />;
		default:
			// 按钮不画：见文件头。
			return null;
	}
}

class Boundary extends Component<{ source: string; fallback: ReactNode; children: ReactNode }, { failed: string | null }> {
	override state = { failed: null as string | null };
	static getDerivedStateFromError() {
		return { failed: "" };
	}
	// 正在写的块，下一段字可能就画得出来了：原文一变就再试一次。
	static getDerivedStateFromProps(props: { source: string }, state: { failed: string | null }) {
		return state.failed === "" ? { failed: props.source } : state.failed !== null && state.failed !== props.source ? { failed: null } : null;
	}
	override render() {
		return this.state.failed === null ? this.props.children : this.props.fallback;
	}
}

/** `table`：把一张 markdown 表画成回复里的表，由 `Markdown` 给，界面块里的表和回复里的长一个样。 */
export function InterfaceBlock({ source, fallback, table, t }: { source: string; fallback: ReactNode; table: (markdown: string) => ReactNode; t: T }) {
	const theme = useTheme();
	const parsed = useMemo(() => parseBlock(source), [source]);
	const initial = useMemo(() => initialState(parsed.nodes), [parsed]);
	const [own, setOwn] = useState<Record<string, unknown>>({});
	if (!parsed.nodes.length) return null;
	const scope: Scope = { values: { ...initial, ...own }, set: (next) => setOwn((was) => ({ ...was, ...next })), depth: 0, theme, t, table };
	return <Boundary source={source} fallback={fallback}>
		<View style={{ marginVertical: 8, gap: 10 }}>
			{renderNodes(parsed.nodes, scope)}
			{hasControls(parsed.nodes) ? <Text style={{ color: theme.faint, fontSize: 12, lineHeight: 17 }}>{t("interfaceOnComputer")}</Text> : null}
		</View>
	</Boundary>;
}
