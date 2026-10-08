import { memo, useMemo } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import Display, { type RenderRules } from "react-native-markdown-display";
import { CopyButton } from "./copy.tsx";
import { mono, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/** 代码块单独一张底：顶上一行语言和复制，正文横向滚动——手机上折行的代码读不成代码。 */
function CodeBlock({ code, language, t }: { code: string; language: string; t: T }) {
	const theme = useTheme();
	const text = code.replace(/\n$/, "");
	return <View style={{ marginVertical: 8, borderRadius: 12, backgroundColor: theme.grouped, borderWidth: 1, borderColor: theme.lineSoft, overflow: "hidden" }}>
		<View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 4, minHeight: 32, borderBottomWidth: 1, borderBottomColor: theme.lineSoft }}>
			<Text style={{ flex: 1, color: theme.muted, fontSize: 11, fontFamily: mono }}>{language || "text"}</Text>
			<CopyButton text={text} label={t("copyCode")} copiedLabel={t("copied")} caption />
		</View>
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}>
			<Text selectable style={{ color: theme.ink, fontFamily: mono, fontSize: 12.5, lineHeight: 19 }}>{text}</Text>
		</ScrollView>
	</View>;
}

function openLink(url: string): boolean {
	if (/^https?:\/\/|^mailto:/i.test(url)) void Linking.openURL(url).catch(() => undefined);
	return false;
}

/**
 * 回复正文。中文正文 16/25：比西文常见的 1.4 倍再松一点，方块字挤在一起比字母更难扫读。
 * 流式输出时这段会每帧重渲，所以样式和规则按主题缓存，不在每次渲染时重建。
 */
export const Markdown = memo(function Markdown({ text, t }: { text: string; t: T }) {
	const theme = useTheme();
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
	return <Display style={style} rules={rules} onLinkPress={openLink}>{text}</Display>;
});
