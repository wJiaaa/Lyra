import { memo, useMemo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import Display, { MarkdownIt, type RenderRules } from "react-native-markdown-display";
import { completeTail } from "@plume/client-runtime/stream-tail";
import { splitBlocks } from "./markdown-chunks.ts";
import { useSmoothText } from "./smooth-text.ts";
import { CopyButton } from "./copy.tsx";
import { mono, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/** 代码块单独一张底：顶上一行语言和复制，正文横向滚动——手机上折行的代码读不成代码。 */
function CodeBlock({ code, language, t }: { code: string; language: string; t: T }) {
	const theme = useTheme();
	const text = code.replace(/\n$/, "");
	return <View style={{ marginVertical: 8, borderRadius: 12, backgroundColor: theme.grouped, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line, overflow: "hidden" }}>
		<View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 4, minHeight: 32 }}>
			<Text style={{ flex: 1, color: theme.faint, fontSize: 11, fontFamily: mono, letterSpacing: 0.6, textTransform: "uppercase" }}>{language || "text"}</Text>
			<CopyButton text={text} label={t("copyCode")} copiedLabel={t("copied")} caption />
		</View>
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 2, paddingBottom: 12 }}>
			<Text selectable style={{ color: theme.ink, fontFamily: mono, fontSize: 12.5, lineHeight: 19 }}>{text}</Text>
		</ScrollView>
	</View>;
}

function openLink(url: string): boolean {
	if (/^https?:\/\/|^mailto:/i.test(url)) void Linking.openURL(url).catch(() => undefined);
	return false;
}

/** 和库默认的同一种配置；只建一次，切块和每块的渲染共用。 */
const markdown = MarkdownIt({ typographer: true });

/** `#rrggbb` 加上透明度；认不出的颜色原样返回（那几个字就不淡入）。 */
function withAlpha(color: string, alpha: number): string {
	const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
	if (!hex) return color;
	return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
}

/**
 * 正在写的那一块里的一段字。只有全块最后一段才淡入末尾：哪一段是最后一段要等整块的规则都跑完才知道，
 * 所以先数、到这个组件渲染时再比——React 先跑完 `Display` 生成整棵树，才渲染树里的这些组件。
 *
 * 淡入的字数按「这一段的结尾和屏幕上最新的那几个字对得上多少」取：最新的字跨过了加粗之类的标记时，
 * 标记前面那几个字在另一段里，就不淡了，少淡几个字不会错，淡错了字会。
 */
function TailText({ content, style, index, count, fresh, alphas }: { content: string; style: unknown; index: number; count: { value: number }; fresh: string[]; alphas: number[] }) {
	const theme = useTheme();
	const flat = StyleSheet.flatten(style as never) as { color?: string } | undefined;
	if (index !== count.value - 1 || fresh.length === 0) return <Text style={style as never}>{content}</Text>;
	const chars = Array.from(content);
	let size = Math.min(fresh.length, chars.length);
	while (size > 0 && chars.slice(-size).join("") !== fresh.slice(-size).join("")) size--;
	const color = flat?.color ?? theme.ink;
	const offset = alphas.length - size;
	return <Text style={style as never}>
		{chars.slice(0, chars.length - size).join("")}
		{chars.slice(chars.length - size).map((char, at) => <Text key={at} style={{ color: withAlpha(color, alphas[offset + at]!) }}>{char}</Text>)}
	</Text>;
}

const Block = memo(function Block({ source, style, rules }: { source: string; style: StyleSheet.NamedStyles<any>; rules: RenderRules }) {
	return <Display style={style} rules={rules} markdownit={markdown} onLinkPress={openLink}>{source}</Display>;
});

/**
 * 回复正文。中文正文 16/25：比西文常见的 1.4 倍再松一点，方块字挤在一起比字母更难扫读。
 *
 * `streaming`：这段字还在一个字一个字地进来，和桌面 `Markdown` 的同名开关做同样三件事——出字按平滑
 * 的节奏走、新字淡入（见 `smooth-text.ts`），最后一段没写完的标记先补上（`completeTail`）。关掉之后
 * 先把剩下的字放完、淡完，再画原文本身。
 */
export const Markdown = memo(function Markdown({ text, streaming = false, t }: { text: string; streaming?: boolean; t: T }) {
	const theme = useTheme();
	const { text: shown, active, tail } = useSmoothText(text, streaming);
	const source = active ? completeTail(shown) : shown;
	const blocks = useMemo(() => splitBlocks(source, markdown.parse(source, {})), [source]);
	const style = useMemo(() => ({
		body: { color: theme.ink, fontSize: 16, lineHeight: 25 },
		paragraph: { marginTop: 0, marginBottom: 12 },
		heading1: { fontSize: 22, lineHeight: 29, fontWeight: "700" as const, color: theme.strong, marginTop: 10, marginBottom: 10 },
		heading2: { fontSize: 19, lineHeight: 26, fontWeight: "700" as const, color: theme.strong, marginTop: 10, marginBottom: 8 },
		heading3: { fontSize: 17, lineHeight: 24, fontWeight: "600" as const, color: theme.strong, marginTop: 8, marginBottom: 6 },
		heading4: { fontSize: 16, lineHeight: 23, fontWeight: "600" as const, color: theme.strong, marginTop: 6, marginBottom: 4 },
		strong: { fontWeight: "600" as const, color: theme.strong },
		em: { fontStyle: "italic" as const },
		// 库的默认样式给行内代码 padding: 10，只盖左右的话上下那 10 还在，底色会比字高出一截。
		code_inline: { backgroundColor: theme.card, color: theme.strong, fontFamily: mono, fontSize: 13.5, borderRadius: 5, padding: 0, paddingHorizontal: 4, borderWidth: 0 },
		blockquote: { backgroundColor: "transparent", borderLeftWidth: 3, borderLeftColor: theme.line, paddingLeft: 12, paddingVertical: 2, marginLeft: 0, marginVertical: 6 },
		bullet_list: { marginBottom: 10 },
		ordered_list: { marginBottom: 10 },
		list_item: { marginBottom: 4 },
		bullet_list_icon: { color: theme.muted, marginLeft: 2, marginRight: 8, lineHeight: 25 },
		ordered_list_icon: { color: theme.muted, marginLeft: 2, marginRight: 8, lineHeight: 25, fontVariant: ["tabular-nums" as const] },
		link: { color: theme.accent, textDecorationLine: "none" as const },
		hr: { backgroundColor: theme.line, height: 1, marginVertical: 16 },
		table: { borderWidth: 1, borderColor: theme.line, borderRadius: 10, marginVertical: 8, overflow: "hidden" as const },
		thead: { backgroundColor: theme.grouped },
		th: { padding: 8, fontWeight: "600" as const, color: theme.strong },
		tr: { borderBottomWidth: 1, borderColor: theme.lineSoft },
		td: { padding: 8 },
	}), [theme]);
	const rules = useMemo<RenderRules>(() => ({
		fence: (node) => <CodeBlock key={node.key} code={node.content} language={((node as { sourceInfo?: string }).sourceInfo ?? "").trim().split(/\s+/)[0] ?? ""} t={t} />,
		code_block: (node) => <CodeBlock key={node.key} code={node.content} language="" t={t} />,
	}), [t]);
	/*
	 * 正在写的最后一块另配一套规则：正文段落走 `TailText`，末尾刚放出来的字淡入。每次渲染新建，
	 * 计数器跟着这一次渲染走；前面那些块用上面那套不变的规则，原文没变就不重画。
	 */
	const fresh = active && tail.length > 0 ? Array.from(shown.slice(-tail.length * 2)).slice(-tail.length) : [];
	const count = { value: 0 };
	const live: RenderRules = fresh.length === 0 ? rules : {
		...rules,
		text: (node, _children, _parent, styles, inherited = {}) => <TailText key={node.key} content={node.content} style={[inherited, styles.text]} index={count.value++} count={count} fresh={fresh} alphas={tail} />,
	};
	return <View>{blocks.map((block, index): ReactNode => <Block key={index} source={block} style={style} rules={index === blocks.length - 1 ? live : rules} />)}</View>;
});
