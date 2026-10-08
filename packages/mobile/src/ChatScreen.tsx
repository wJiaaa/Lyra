import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ClientState, RemoteClient } from "@plume/client-runtime";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChoiceSheet } from "./ChoiceSheet.tsx";
import { Composer } from "./Composer.tsx";
import { pickImages, MAX_IMAGES, type Attachment } from "./attachments.ts";
import { buildFeed, findStep, flatten, type Step } from "./feed.ts";
import { FeedRow } from "./MessageRow.tsx";
import { PlanBar } from "./PlanBar.tsx";
import { Sheet } from "./Sheet.tsx";
import { ToolSheet } from "./ToolSheet.tsx";
import { latestTodos } from "./tools.ts";
import { Button, Field, GroupRow, Group, Header, Icon, IconButton, ProjectMark, StatusDot, Txt, floating, nativeDriver, styles, useTheme } from "./ui.tsx";
import { avatar } from "./avatar.ts";
import type { T } from "./i18n.ts";

type ScrollNode = { addEventListener(type: string, listener: () => void, options?: { passive: boolean }): void; removeEventListener(type: string, listener: () => void): void };

function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 三个依次亮起的点：说明它在动，又不像转圈那样抢眼。 */
function Pulse() {
	const theme = useTheme();
	const value = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const loop = Animated.loop(Animated.timing(value, { toValue: 3, duration: 1200, useNativeDriver: nativeDriver }));
		loop.start();
		return () => loop.stop();
	}, [value]);
	return <View style={{ flexDirection: "row", gap: 3 }}>
		{[0, 1, 2].map((index) => <Animated.View key={index} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.accent, opacity: value.interpolate({ inputRange: [0, index, index + 0.5, index + 1, 3], outputRange: [0.25, 0.25, 1, 0.25, 0.25], extrapolate: "clamp" }) }} />)}
	</View>;
}

function Working({ since, t }: { since: number | null; t: T }) {
	const theme = useTheme();
	const [now, setNow] = useState(Date.now());
	useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
	return <View accessibilityLiveRegion="polite" style={[floating(theme), { height: 36, borderRadius: 18, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 9 }]}>
		<Pulse />
		<Text style={{ color: theme.ink, fontSize: 13, fontWeight: "500" }}>{t("working")}</Text>
		{since !== null && <Text style={{ color: theme.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{clock(now - since)}</Text>}
	</View>;
}

function ActionsSheet({ state, client, close, error, t }: { state: ClientState; client: RemoteClient; close(): void; error(cause: unknown): void; t: T }) {
	const theme = useTheme();
	const session = state.session;
	const online = state.status === "connected";
	const [title, setTitle] = useState(session?.meta.title ?? "");
	const [busy, setBusy] = useState(false);
	return <Sheet title={t("more")} close={close} closeLabel={t("close")}>
		{(dismiss) => <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 16 }}>
			<View style={{ gap: 8 }}>
				<Field accessibilityLabel={t("title")} placeholder={t("title")} value={title} onChangeText={setTitle} returnKeyType="done" />
				<Button label={t("rename")} busy={busy} disabled={!online || !title.trim() || title.trim() === session?.meta.title} onPress={() => { setBusy(true); void client.rename(title.trim()).then(dismiss).catch(error).finally(() => setBusy(false)); }} />
			</View>
			<Group style={{ backgroundColor: theme.card }}>
				<GroupRow first icon={session?.meta.archived ? "rotate-ccw" : "archive"} label={t(session?.meta.archived ? "restore" : "archive")} danger={!session?.meta.archived} chevron={false} disabled={!online || !!session?.running} onPress={() => {
					const id = state.activeId;
					if (id) void client.archive(id, !session?.meta.archived).then(() => { close(); client.closeSession(); }).catch(error);
				}} />
			</Group>
		</ScrollView>}
	</Sheet>;
}

export function ChatScreen({ state, client, back, error, draft, setDraft, t }: { state: ClientState; client: RemoteClient; back(): void; error(cause: unknown): void; draft: string; setDraft(value: string): void; t: T }) {
	const theme = useTheme();
	const { height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const [sending, setSending] = useState(false);
	const [sheet, setSheet] = useState<"model" | "thinking" | "actions" | "attach" | null>(null);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [stepId, setStepId] = useState<string | null>(null);
	const [following, setFollowing] = useState(true);
	const [scrolled, setScrolled] = useState(false);
	const list = useRef<FlatList>(null);
	const follow = useRef(true);
	/** 人最后一次亲手滚它的时间；手指还按着时是 Infinity。 */
	const touched = useRef(0);
	const listed = !!state.session;
	useEffect(() => {
		// 网页预览里滚轮和触摸板不发拖动事件，直接听滚动节点上的原生事件。
		if (Platform.OS !== "web" || !listed) return;
		const node = (list.current as unknown as { getScrollableNode?(): ScrollNode | null } | null)?.getScrollableNode?.();
		if (!node) return;
		const mark = () => { touched.current = Date.now(); };
		for (const type of ["wheel", "touchmove", "keydown"]) node.addEventListener(type, mark, { passive: true });
		return () => { for (const type of ["wheel", "touchmove", "keydown"]) node.removeEventListener(type, mark); };
	}, [listed]);
	const session = state.session;
	const online = state.status === "connected";
	const model = state.bootstrap?.models.find((entry) => entry.id === session?.meta.modelId);
	const visible = useMemo(() => session?.messages.filter((message) => message.role !== "user" || !message.synthetic || message.delivery || message.peer) ?? [], [session?.messages]);
	const running = !!session?.running;
	const feed = useMemo(() => buildFeed(visible, running), [visible, running]);
	const rows = useMemo(() => flatten(feed, expanded), [feed, expanded]);
	const todos = useMemo(() => latestTodos(visible), [visible]);
	const step = stepId ? findStep(feed, stepId) : null;
	const since = running ? [...visible].reverse().find((message) => message.role === "user")?.timestamp ?? null : null;
	const pending = session?.pendingApprovals[0];
	const thinking = model?.thinkingOptions.length ? model.thinkingOptions.find((option) => option.value === (session?.meta.thinking ?? state.bootstrap?.thinking))?.label ?? session?.meta.thinking ?? state.bootstrap?.thinking ?? "" : null;
	function send() {
		const text = draft;
		setSending(true);
		follow.current = true;
		void client.prompt(text, attachments.map(({ data, mimeType }) => ({ data, mimeType }))).then(() => { setDraft(""); setAttachments([]); }).catch(error).finally(() => setSending(false));
	}
	function attach(source: "library" | "camera") {
		void pickImages(source, MAX_IMAGES - attachments.length).then((picked) => {
			if (picked === null) error(new Error(t("cameraBody")));
			else if (picked.length) setAttachments((current) => [...current, ...picked].slice(0, MAX_IMAGES));
		}).catch(error);
	}
	const toggle = useCallback((key: string) => setExpanded((current) => {
		const next = new Set(current);
		if (!next.delete(key)) next.add(key);
		return next;
	}), []);
	const openStep = useCallback((target: Step) => setStepId(target.id), []);
	const retry = useCallback((text: string) => { follow.current = true; void client.prompt(text).catch(error); }, [client, error]);
	/*
	 * 走底下那层 ScrollView 的 scrollToEnd，不走 FlatList 自己的：后者按它记下的单元格尺寸算偏移，
	 * 回答刚长出来、单元格还没量完时会停在离底部一截的地方，最后几行压在输入框和「正在工作」底下。
	 * 前者在网页上读真实的 scrollHeight，原生端用原生的内容尺寸。
	 */
	function bottom(animated: boolean) { (list.current?.getNativeScrollRef() as ScrollView | null | undefined)?.scrollToEnd({ animated }); }
	function toEnd() { follow.current = true; setFollowing(true); bottom(true); }
	const subtitle = <View style={[styles.row, { gap: 5, marginTop: 1 }]}>
		{online ? <ProjectMark name={session?.meta.projectName} size={12} /> : <StatusDot status={state.status} size={6} />}
		<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12, flexShrink: 1 }}>{online ? session?.meta.projectName || t("scratch") : t(state.status)}</Text>
	</View>;
	// KeyboardAvoidingView 拿自己 onLayout 的 y（相对父级）去减键盘的屏幕坐标；这一页在 App 的 SafeAreaView
	// 里，从顶部安全区下沿才开始，不补这一段，垫高就少一个刘海，输入框下半截压在键盘后面。
	return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top}>
		<Header title={session?.meta.title || t("newSession")} subtitle={subtitle} onBack={back} backLabel={t("back")} divided={scrolled}>
			<IconButton name="more-horizontal" label={t("more")} onPress={() => setSheet("actions")} disabled={!session} filled size={18} />
		</Header>
		<View style={{ flex: 1 }}>
			{state.loading && !session ? <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator color={theme.muted} /></View> : <FlatList
				ref={list}
				data={rows}
				keyExtractor={(row) => row.item.key}
				contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 56 }}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="interactive"
				onScrollBeginDrag={() => { touched.current = Infinity; }}
				onScrollEndDrag={() => { touched.current = Date.now(); }}
				onMomentumScrollEnd={() => { touched.current = Date.now(); }}
				onLayout={() => { if (follow.current) bottom(false); }}
				onScroll={({ nativeEvent: event }) => {
					const atEnd = event.contentOffset.y + event.layoutMeasurement.height >= event.contentSize.height - 80;
					const below = event.contentOffset.y > 2;
					if (below !== scrolled) setScrolled(below);
					/*
					 * 只有人自己往上翻才停止跟随。回答一下子长出一大段、计划条出现把列表压矮时，滚动事件
					 * 拿着旧位置看起来不在底部——按位置判断就会把跟随误关，后面的回答停在屏幕外。
					 * 回到底部永远可以重新跟上。
					 */
					if (!atEnd && Date.now() - touched.current > 400) return;
					follow.current = atEnd;
					if (atEnd !== following) setFollowing(atEnd);
				}}
				scrollEventThrottle={100}
				onContentSizeChange={() => { if (follow.current) bottom(false); }}
				renderItem={({ item: row }) => <FeedRow item={row.item} nested={row.nested} expanded={expanded.has(row.item.key)} toggle={toggle} openStep={openStep} retry={online && !running ? retry : undefined} t={t} />}
				ListEmptyComponent={<View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 10, paddingHorizontal: 24 }}>
					<Image source={avatar} accessibilityIgnoresInvertColors style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.grouped, marginBottom: 6 }} />
					<Txt kind="heading" tone="strong" style={{ fontSize: 18, lineHeight: 24, fontWeight: "700" }}>{t("welcome")}</Txt>
					<Txt kind="sub" tone="muted" style={{ textAlign: "center", maxWidth: 300 }}>{t("welcomeHint")}</Txt>
				</View>}
			/>}
			<View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 10, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 }}>
				{running && !pending && <Working since={since} t={t} />}
				{!following && rows.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={t("scrollDown")} onPress={toEnd} style={({ pressed }) => [floating(theme), { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.7 : 1 }]}><Icon name="chevron-down" size={18} /></Pressable>}
			</View>
		</View>
		{!online && <View style={[styles.row, { marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: theme.grouped }]}>
			<StatusDot status={state.status} />
			<Txt kind="caption" tone="muted" style={{ flex: 1 }}>{t(state.status)} · {t("reconnectHint")}</Txt>
		</View>}
		{!pending && todos && <PlanBar todos={todos} running={running} t={t} />}
		{pending && <View style={{ maxHeight: height * 0.55 }}><ApprovalCard key={pending.id} request={pending} answer={(decision) => client.approve(pending.id, decision)} disabled={!online} error={error} t={t} /></View>}
		<Composer
			draft={draft}
			setDraft={setDraft}
			attachments={attachments}
			canAttach={model?.images ?? false}
			attach={() => attachments.length >= MAX_IMAGES ? error(new Error(t("imageLimit", { n: MAX_IMAGES }))) : setSheet("attach")}
			detach={(index) => setAttachments((current) => current.filter((_, at) => at !== index))}
			send={send}
			stop={() => void client.abort().catch(error)}
			sending={sending}
			running={running}
			online={online}
			ready={!!session}
			model={model?.name || session?.meta.modelId || t("model")}
			thinking={thinking}
			pickModel={() => setSheet("model")}
			pickThinking={() => setSheet("thinking")}
			t={t}
		/>
		{(sheet === "model" || sheet === "thinking") && <ChoiceSheet
			title={t(sheet)}
			options={sheet === "model" ? (state.bootstrap?.models ?? []).map((entry) => ({ value: entry.id, label: entry.name, detail: entry.provider })) : model?.thinkingOptions ?? []}
			value={sheet === "model" ? session?.meta.modelId ?? "" : session?.meta.thinking ?? state.bootstrap?.thinking ?? ""}
			choose={(value) => void (sheet === "model" ? client.setModel(value) : client.setThinking(value)).catch(error)}
			close={() => setSheet(null)}
			t={t}
		/>}
		{sheet === "attach" && <Sheet title={t("attach")} close={() => setSheet(null)} closeLabel={t("close")}>
			{(dismiss) => <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
				<Group style={{ backgroundColor: theme.card }}>
					<GroupRow first icon="image" label={t("photos")} chevron={false} onPress={() => { dismiss(); attach("library"); }} />
					<GroupRow icon="camera" label={t("takePhoto")} chevron={false} onPress={() => { dismiss(); attach("camera"); }} />
				</Group>
			</View>}
		</Sheet>}
		{step && <ToolSheet step={step} running={running} close={() => setStepId(null)} t={t} />}
		{sheet === "actions" && <ActionsSheet state={state} client={client} close={() => setSheet(null)} error={error} t={t} />}
	</KeyboardAvoidingView>;
}
