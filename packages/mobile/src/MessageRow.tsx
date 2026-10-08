import { memo, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import type { FeedItem, Step } from "./feed.ts";
import { CopyButton, useCopy } from "./copy.tsx";
import { Markdown } from "./Markdown.tsx";
import { DiffStat } from "./ToolSheet.tsx";
import { describeCalls, diffStat, sumStats, toolIcon, toolSubject, toolVerb } from "./tools.ts";
import { Button, Icon, Txt, styles, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

function duration(ms: number, t: T): string {
	const total = Math.max(1, Math.round(ms / 1000));
	return total < 60 ? t("seconds", { s: total }) : t("minutes", { m: Math.floor(total / 60), s: String(total % 60).padStart(2, "0") });
}
const clockOf = (timestamp: number) => { const date = new Date(timestamp); return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`; };

/** 摘要、步骤、思考共用的一行：左边 20 宽的图标槽和正文的字对齐，不另起卡片。 */
function Line({ icon, label, onPress, expanded, children, trailing }: { icon: ReactNode; label: string; onPress(): void; expanded?: boolean; children: ReactNode; trailing?: ReactNode }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={expanded === undefined ? undefined : { expanded }} onPress={onPress} style={({ pressed }) => [styles.row, { minHeight: 34, gap: 8, borderRadius: 10, marginHorizontal: -8, paddingHorizontal: 8 }, pressed && { backgroundColor: theme.card }]}>
		<View style={{ width: 20, alignItems: "center" }}>{icon}</View>
		<Text numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 19, color: theme.muted }}>{children}</Text>
		{trailing}
	</Pressable>;
}

function StepRow({ step, live, open, t }: { step: Step; live: boolean; open(step: Step): void; t: T }) {
	const theme = useTheme();
	const verb = toolVerb(step.name, t);
	const subject = toolSubject(step.name, step.args);
	const spinning = live && !step.done;
	const icon = spinning ? <ActivityIndicator size="small" color={theme.muted} style={{ transform: [{ scale: 0.7 }] }} />
		: <Icon name={step.failed ? "alert-circle" : toolIcon(step.name)} size={15} color={step.failed ? theme.danger : theme.muted} />;
	return <Line icon={icon} label={`${verb} ${subject}`} onPress={() => open(step)} trailing={<><DiffStat stat={diffStat(step.details)} /><Icon name="chevron-right" size={13} color={theme.faint} /></>}>
		<Text style={{ color: step.failed ? theme.danger : theme.ink, fontWeight: "500" }}>{verb}</Text>
		{subject ? `  ${subject}` : ""}
	</Line>;
}

function Thinking({ item, t }: { item: Extract<FeedItem, { kind: "thinking" }>; t: T }) {
	const theme = useTheme();
	const [open, setOpen] = useState(false);
	const preview = item.text.trim().split("\n")[0] ?? "";
	return <View>
		<Line icon={<Icon name="cpu" size={15} color={theme.muted} />} label={t("thinkingLabel")} expanded={open} onPress={() => setOpen(!open)} trailing={<Icon name={open ? "chevron-up" : "chevron-down"} size={13} color={theme.faint} />}>
			<Text style={{ color: theme.ink, fontWeight: "500" }}>{item.live ? t("thinkingLive") : t("thinkingLabel")}</Text>
			{!open && preview ? `  ${preview}` : ""}
		</Line>
		{open && <View style={{ marginLeft: 9, paddingLeft: 19, borderLeftWidth: 1, borderLeftColor: theme.line, marginTop: 2, marginBottom: 6 }}>
			<Text selectable style={{ color: theme.muted, fontSize: 14, lineHeight: 22 }}>{item.text.trim()}</Text>
		</View>}
	</View>;
}

/** 做完的一轮的过程：用了多久、做了哪几类事、改了多少行。点开把原样内容接在下面。 */
function Fold({ item, expanded, toggle, t }: { item: Extract<FeedItem, { kind: "fold" }>; expanded: boolean; toggle(key: string): void; t: T }) {
	const theme = useTheme();
	const summary = [item.thinking ? t("thoughtTimes", { n: item.thinking }) : "", item.steps.length ? describeCalls(item.steps, t) : ""].filter(Boolean).join(" · ");
	const failed = item.steps.some((step) => step.failed);
	return <View style={{ paddingVertical: 2 }}>
		<Line icon={<Icon name={failed ? "alert-circle" : "check-circle"} size={15} color={failed ? theme.danger : theme.muted} />} label={`${t("worked", { d: duration(item.durationMs, t) })} ${summary}`} expanded={expanded} onPress={() => toggle(item.key)} trailing={<><DiffStat stat={sumStats(item.steps.map((step) => step.details))} /><Icon name={expanded ? "chevron-up" : "chevron-down"} size={13} color={theme.faint} /></>}>
			<Text style={{ color: theme.ink, fontWeight: "500" }}>{t("worked", { d: duration(item.durationMs, t) })}</Text>
			{summary ? `  ${summary}` : ""}
		</Line>
	</View>;
}

function UserBubble({ item, t }: { item: Extract<FeedItem, { kind: "user" }>; t: T }) {
	const theme = useTheme();
	const [copied, copy] = useCopy();
	return <View style={{ alignItems: "flex-end", paddingTop: 20, paddingBottom: 8, gap: 6 }}>
		{item.images.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, maxWidth: "86%" }}>
			{item.images.map((image, index) => image.data
				? <Image key={index} accessibilityLabel={t("image")} source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={{ width: 96, height: 96, borderRadius: 14, backgroundColor: theme.card }} />
				// 存储里的大图在回放时被剥掉了字节，只剩电脑上的引用；手机拿不到，就老实说图在电脑上。
				: <View key={index} accessibilityLabel={t("unavailable")} style={{ width: 96, height: 96, borderRadius: 14, backgroundColor: theme.card, alignItems: "center", justifyContent: "center", gap: 6, padding: 8 }}>
					<Icon name="image" size={20} color={theme.faint} />
					<Text numberOfLines={2} style={{ color: theme.faint, fontSize: 10, textAlign: "center" }}>{t("unavailable")}</Text>
				</View>)}
		</View>}
		{!!item.text && <Pressable accessibilityHint={t("copy")} onLongPress={() => copy(item.text)} delayLongPress={350} style={({ pressed }) => ({ maxWidth: "86%", backgroundColor: theme.card, borderRadius: 20, borderTopRightRadius: 6, paddingHorizontal: 15, paddingVertical: 10, opacity: pressed ? 0.85 : 1 })}>
			<Text style={{ color: theme.ink, fontSize: 16, lineHeight: 23 }}>{item.text}</Text>
		</Pressable>}
		{copied && <Txt kind="caption" tone="success">{t("copied")}</Txt>}
	</View>;
}

/** 一轮的结尾：什么时候答完、花了多久，和一颗复制整段回答的按钮。只跟在做完的最终回答后面。 */
function Footer({ item, t }: { item: Extract<FeedItem, { kind: "footer" }>; t: T }) {
	const theme = useTheme();
	return <View style={[styles.row, { gap: 4, marginTop: -4, marginBottom: 6, marginLeft: -6 }]}>
		<CopyButton text={item.text} label={t("copy")} copiedLabel={t("copied")} />
		<Text style={{ color: theme.faint, fontSize: 12, fontVariant: ["tabular-nums"] }}>{clockOf(item.timestamp)}{item.durationMs >= 1000 ? ` · ${duration(item.durationMs, t)}` : ""}</Text>
	</View>;
}

function ErrorCard({ item, retry, t }: { item: Extract<FeedItem, { kind: "error" }>; retry?: (text: string) => void; t: T }) {
	const theme = useTheme();
	return <View accessibilityRole="alert" style={{ marginVertical: 8, padding: 12, borderRadius: 14, backgroundColor: theme.dangerSoft, gap: 10 }}>
		<View style={[styles.row, { alignItems: "flex-start", gap: 8 }]}>
			<View style={{ paddingTop: 2 }}><Icon name="alert-circle" size={15} color={theme.danger} /></View>
			<Text selectable style={{ flex: 1, color: theme.danger, fontSize: 14, lineHeight: 20 }}>{item.text}</Text>
		</View>
		{item.retry && retry && <View style={{ alignSelf: "flex-start" }}><Button label={t("retry")} icon="rotate-cw" variant="danger" small onPress={() => retry(item.retry!)} /></View>}
	</View>;
}

/**
 * 列表里的一行。展开的那一轮过程（`nested`）挂在左边一条细线上，和它的摘要行连成一组，
 * 收起时整组一起消失——不然展开后分不清哪几步属于哪一轮。
 */
export const FeedRow = memo(function FeedRow({ item, nested, expanded, toggle, openStep, retry, t }: { item: FeedItem; nested: boolean; expanded: boolean; toggle(key: string): void; openStep(step: Step): void; retry?: (text: string) => void; t: T }) {
	const theme = useTheme();
	const body = item.kind === "user" ? <UserBubble item={item} t={t} />
		: item.kind === "steps" ? <View style={{ paddingVertical: 2 }}>{item.steps.map((step) => <StepRow key={step.id} step={step} live={item.live} open={openStep} t={t} />)}</View>
		: item.kind === "thinking" ? <Thinking item={item} t={t} />
		: item.kind === "fold" ? <Fold item={item} expanded={expanded} toggle={toggle} t={t} />
		: item.kind === "footer" ? <Footer item={item} t={t} />
		: item.kind === "error" ? <ErrorCard item={item} retry={retry} t={t} />
		: <View style={{ paddingTop: 6, paddingBottom: 2 }}><Markdown text={item.text} t={t} /></View>;
	if (!nested) return body;
	return <View style={{ marginLeft: 9, paddingLeft: 17, borderLeftWidth: 1, borderLeftColor: theme.line }}>{body}</View>;
});
