import { useMemo, useState } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ClientState, RemoteClient, SessionMeta } from "@plume/client-runtime";
import { NewSessionSheet } from "./NewSessionSheet.tsx";
import { Sheet } from "./Sheet.tsx";
import { Field, Group, GroupRow, Icon, IconButton, StatusDot, Txt, styles, useTheme } from "./ui.tsx";
import { ago, groupSessions, visibleSessions } from "./sessions.ts";
import type { T } from "./i18n.ts";

type Filter = "all" | "running" | "archived";

function When({ time, now, t }: { time: number; now: number; t: T }) {
	const theme = useTheme();
	const value = ago(time, now);
	const text = value.key === "date" ? value.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : value.key === "justNow" ? t("justNow") : t(value.key, { n: value.n });
	return <Text style={{ color: theme.faint, fontSize: 13, fontVariant: ["tabular-nums"] }}>{text}</Text>;
}

function Row({ item, running, now, onOpen, onHold, t }: { item: SessionMeta; running: boolean; now: number; onOpen(): void; onHold(): void; t: T }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={item.title || t("newSession")} onPress={onOpen} onLongPress={onHold} delayLongPress={350} style={({ pressed }) => ({ paddingHorizontal: 20, paddingVertical: 12, gap: 4, backgroundColor: pressed ? theme.grouped : "transparent" })}>
		<View style={[styles.row, { gap: 6 }]}>
			<Icon name="folder" size={12} color={theme.faint} />
			<Text numberOfLines={1} style={{ flex: 1, color: theme.muted, fontSize: 13, fontWeight: "500" }}>{item.projectName || t("scratch")}</Text>
			{running ? <View style={[styles.row, { gap: 6 }]}><StatusDot status="connected" size={6} /><Text style={{ color: theme.success, fontSize: 13, fontWeight: "600" }}>{t("running")}</Text></View> : <When time={item.updatedAt} now={now} t={t} />}
		</View>
		<Text numberOfLines={2} style={{ color: theme.ink, fontSize: 16, lineHeight: 22, fontWeight: "500" }}>{item.title || t("newSession")}</Text>
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
	return <View style={styles.page}>
		<View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, flexDirection: "row", alignItems: "center", gap: 12 }}>
			<View style={{ flex: 1, minWidth: 0 }}>
				<Txt kind="title" tone="strong">{t("sessions")}</Txt>
				<View style={[styles.row, { gap: 7, marginTop: 2 }]}>
					<StatusDot status={state.status} size={7} />
					<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 13, flexShrink: 1 }}>{online && desktop ? desktop : t(state.status)}</Text>
				</View>
			</View>
			<IconButton name="settings" label={t("settings")} onPress={onSettings} filled />
		</View>
		<View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
			<Field icon="search" accessibilityLabel={t("search")} placeholder={t("search")} value={query} onChangeText={setQuery} autoCorrect={false} clearButtonMode="while-editing" style={{ minHeight: 42, paddingVertical: 9 }} />
			<View style={[styles.row, { gap: 6 }]}>
				{(["all", "running", "archived"] as const).map((item) => {
					const selected = filter === item;
					const count = item === "running" ? running.length : 0;
					return <Pressable key={item} accessibilityRole="button" accessibilityLabel={t(item)} accessibilityState={{ selected }} onPress={() => setFilter(item)} style={{ height: 32, paddingHorizontal: 13, borderRadius: 16, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: selected ? theme.ink : theme.grouped }}>
						<Text style={{ fontSize: 13, fontWeight: "600", color: selected ? theme.bg : theme.muted }}>{t(item)}</Text>
						{count > 0 && <Text style={{ fontSize: 12, fontWeight: "600", color: selected ? theme.bg : theme.success }}>{count}</Text>}
					</Pressable>;
				})}
			</View>
		</View>
		<SectionList
			sections={sections}
			keyExtractor={(item) => item.id}
			stickySectionHeadersEnabled={false}
			contentContainerStyle={{ flexGrow: 1, paddingTop: 4, paddingBottom: 96 + insets.bottom }}
			refreshing={refreshing}
			onRefresh={() => { setRefreshing(true); void client.refresh().catch(error).finally(() => setRefreshing(false)); }}
			renderSectionHeader={({ section }) => <View style={[styles.row, { paddingHorizontal: 20, marginTop: 18, marginBottom: 4 }]}>
				<Text style={{ color: theme.faint, fontSize: 12, fontWeight: "600" }}>{t(section.title)}</Text>
				<View style={{ flex: 1, height: 1, backgroundColor: theme.lineSoft }} />
			</View>}
			ItemSeparatorComponent={() => <View style={{ marginLeft: 20, height: 1, backgroundColor: theme.lineSoft }} />}
			renderItem={({ item }) => <Row item={item} running={running.includes(item.id)} now={now} onOpen={() => onOpen(item.id)} onHold={() => setHeld(item)} t={t} />}
			ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
				<View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: theme.grouped, alignItems: "center", justifyContent: "center", marginBottom: 8 }}><Icon name="message-square" size={22} color={theme.muted} /></View>
				<Txt kind="heading" tone="strong">{t(query || filter !== "all" ? "noResults" : "empty")}</Txt>
				{!query && filter === "all" && <Txt kind="sub" tone="muted" style={{ textAlign: "center", maxWidth: 300 }}>{t("emptyHint")}</Txt>}
			</View>}
		/>
		<Pressable accessibilityRole="button" accessibilityLabel={t("newSession")} accessibilityState={{ disabled: !online || !state.bootstrap }} disabled={!online || !state.bootstrap} onPress={() => setCreating(true)} style={({ pressed }) => ({ position: "absolute", right: 20, bottom: 20 + insets.bottom, height: 52, paddingHorizontal: 20, borderRadius: 26, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.accent, opacity: !online ? 0.4 : pressed ? 0.8 : 1, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6 })}>
			<Icon name="edit" size={18} color={theme.onAccent} />
			<Text style={{ color: theme.onAccent, fontSize: 16, fontWeight: "600" }}>{t("newSession")}</Text>
		</Pressable>
		{creating && state.bootstrap && <NewSessionSheet bootstrap={state.bootstrap} client={client} close={() => setCreating(false)} created={onCreated} error={error} t={t} />}
		{held && <Sheet title={held.title || t("newSession")} close={() => setHeld(null)} closeLabel={t("close")}>
			{(dismiss) => <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
				<Group style={{ backgroundColor: theme.card }}>
					<GroupRow first icon={held.archived ? "rotate-ccw" : "archive"} label={t(held.archived ? "restore" : "archive")} danger={!held.archived} chevron={false} disabled={!online || running.includes(held.id)} onPress={() => { const target = held; dismiss(); void client.archive(target.id, !target.archived).catch(error); }} />
				</Group>
			</View>}
		</Sheet>}
	</View>;
}
