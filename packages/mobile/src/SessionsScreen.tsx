import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ClientState, RemoteClient, SessionMeta } from "@plume/client-runtime";
import { NewSessionSheet } from "./NewSessionSheet.tsx";
import { SessionActions } from "./SessionActions.tsx";
import { Field, Header, Icon, IconButton, ProjectMark, StatusDot, Txt, styles, useTheme } from "./ui.tsx";
import { ago, groupSessions, visibleSessions } from "./sessions.ts";
import type { T } from "./i18n.ts";

type Filter = "all" | "running" | "archived";

function When({ time, now, t }: { time: number; now: number; t: T }) {
	const theme = useTheme();
	const value = ago(time, now);
	const text = value.key === "date" ? value.date.toLocaleDateString(t("dateLocale"), { month: "short", day: "numeric" }) : value.key === "justNow" ? t("justNow") : t(value.key, { n: value.n });
	return <Text style={{ color: theme.faint, fontSize: 13, fontVariant: ["tabular-nums"] }}>{text}</Text>;
}

/** 一行三样：哪个项目、什么时候（跑着时换成蓝色「进行中」）、标题。不套卡片，行与行之间一条从文字起头的发丝线。 */
function Row({ item, running, now, onOpen, onHold, t }: { item: SessionMeta; running: boolean; now: number; onOpen(): void; onHold(): void; t: T }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={item.title || t("newSession")} onPress={onOpen} onLongPress={onHold} delayLongPress={350} style={({ pressed }) => ({ paddingHorizontal: 20, paddingVertical: 11, gap: 4, backgroundColor: pressed ? theme.grouped : "transparent" })}>
		<View style={[styles.row, { gap: 7 }]}>
			<ProjectMark name={item.projectName} size={16} />
			<Text numberOfLines={1} style={{ flex: 1, color: theme.muted, fontSize: 13, fontWeight: "500" }}>{item.projectName || t("scratch")}</Text>
			{/* 借连接中的那圈呼吸光：在跑的会话点是活的，和「已连接」那种静止的绿点区分开。 */}
			{running ? <View style={[styles.row, { gap: 6 }]}><StatusDot status="connecting" color={theme.accent} size={6} /><Text style={{ color: theme.accent, fontSize: 13, fontWeight: "600" }}>{t("running")}</Text></View> : <When time={item.updatedAt} now={now} t={t} />}
		</View>
		<Text numberOfLines={2} style={{ color: theme.strong, fontSize: 16, lineHeight: 22, fontWeight: "500" }}>{item.title || t("newSession")}</Text>
	</Pressable>;
}

export function SessionsScreen({ state, client, onSettings, onOpen, onCreated, error, t }: { state: ClientState; client: RemoteClient; onSettings(): void; onOpen(id: string): void; onCreated(): void; error(cause: unknown): void; t: T }) {
	const theme = useTheme();
	const insets = useSafeAreaInsets();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [refreshing, setRefreshing] = useState(false);
	const [creating, setCreating] = useState(false);
	const [held, setHeld] = useState<SessionMeta | null>(null);
	const running = useMemo(() => state.bootstrap?.runningSessionIds ?? [], [state.bootstrap?.runningSessionIds]);
	const online = state.status === "connected";
	const now = Date.now();
	const sections = useMemo(() => groupSessions(visibleSessions(state.bootstrap?.sessions ?? [], query, filter, running), Date.now()).map((group) => ({ title: group.bucket, data: group.items })), [state.bootstrap?.sessions, query, filter, running]);
	const desktop = state.bootstrap?.name;
	const canCreate = online && !!state.bootstrap;
	return <View style={styles.page}>
		<Header
			title={t("sessions")}
			subtitle={<View style={[styles.row, { gap: 6, marginTop: 1 }]}>
				<StatusDot status={state.status} size={6} />
				<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12, flexShrink: 1 }}>{online && desktop ? desktop : t(state.status)}</Text>
			</View>}
			leading={<IconButton name="settings" label={t("settings")} onPress={onSettings} filled size={18} />}
		>
			<IconButton name="edit" label={t("newSession")} onPress={() => setCreating(true)} disabled={!canCreate} filled size={18} />
		</Header>
		<View style={{ paddingHorizontal: 16, paddingTop: 6, gap: 10 }}>
			<Field icon="search" compact accessibilityLabel={t("search")} placeholder={t("search")} value={query} onChangeText={setQuery} autoCorrect={false} clearButtonMode="while-editing" />
			<View style={[styles.row, { gap: 4 }]}>
				{(["all", "running", "archived"] as const).map((item) => {
					const selected = filter === item;
					const count = item === "running" ? running.length : 0;
					return <Pressable key={item} accessibilityRole="button" accessibilityLabel={t(item)} accessibilityState={{ selected }} onPress={() => setFilter(item)} style={({ pressed }) => ({ height: 30, paddingHorizontal: 12, borderRadius: 15, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: selected ? theme.card : "transparent", opacity: pressed ? 0.6 : 1 })}>
						<Text style={{ fontSize: 14, fontWeight: selected ? "600" : "500", color: selected ? theme.strong : theme.muted }}>{t(item)}</Text>
						{count > 0 && <Text style={{ fontSize: 12, fontWeight: "700", color: theme.accent, fontVariant: ["tabular-nums"] }}>{count}</Text>}
					</Pressable>;
				})}
			</View>
		</View>
		<SectionList
			sections={sections}
			keyExtractor={(item) => item.id}
			stickySectionHeadersEnabled={false}
			contentContainerStyle={{ flexGrow: 1, paddingTop: 2, paddingBottom: 24 + insets.bottom }}
			refreshing={refreshing}
			onRefresh={() => { setRefreshing(true); void client.refresh().catch(error).finally(() => setRefreshing(false)); }}
			renderSectionHeader={({ section }) => <View style={[styles.row, { paddingHorizontal: 20, marginTop: 20, marginBottom: 2 }]}>
				<Text style={{ color: theme.faint, fontSize: 13, fontWeight: "500" }}>{t(section.title)}</Text>
				<View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />
			</View>}
			ItemSeparatorComponent={() => <View style={{ marginLeft: 43, height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />}
			renderItem={({ item }) => <Row item={item} running={running.includes(item.id)} now={now} onOpen={() => onOpen(item.id)} onHold={() => setHeld(item)} t={t} />}
			ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
				<Txt kind="heading" tone="strong" style={{ fontSize: 20, lineHeight: 26, fontWeight: "700" }}>{t(query || filter !== "all" ? "noResults" : "empty")}</Txt>
				{!query && filter === "all" && <>
					<Txt kind="sub" tone="muted" style={{ textAlign: "center", maxWidth: 280 }}>{t("emptyHint")}</Txt>
					<Pressable accessibilityRole="button" accessibilityLabel={t("newSession")} disabled={!canCreate} onPress={() => setCreating(true)} style={({ pressed }) => ({ marginTop: 14, height: 42, paddingHorizontal: 20, borderRadius: 21, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.accent, opacity: !canCreate ? 0.4 : pressed ? 0.8 : 1 })}>
						<Icon name="edit" size={16} color={theme.onAccent} />
						<Text style={{ color: theme.onAccent, fontSize: 15, fontWeight: "600" }}>{t("newSession")}</Text>
					</Pressable>
				</>}
			</View>}
		/>
		{creating && state.bootstrap && <NewSessionSheet bootstrap={state.bootstrap} client={client} close={() => setCreating(false)} created={onCreated} error={error} t={t} />}
		{held && <SessionActions title={held.title || t("newSession")} meta={held} running={running.includes(held.id)} online={online} archive={() => client.archive(held.id, !held.archived)} close={() => setHeld(null)} error={error} t={t} />}
	</View>;
}
