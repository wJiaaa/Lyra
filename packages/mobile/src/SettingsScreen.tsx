import { ScrollView, View } from "react-native";
import type { ClientState, Connection } from "@plume/client-runtime";
import { Eyebrow, Group, GroupRow, Header, StatusDot, Txt, useTheme } from "./ui.tsx";
import type { Locale, T } from "./i18n.ts";

export function SettingsScreen({ state, connection, locale, setLocale, refresh, disconnect, back, t }: { state: ClientState; connection: Connection | null; locale: Locale; setLocale(locale: Locale): void; refresh(): void; disconnect(): void; back(): void; t: T }) {
	const theme = useTheme();
	const online = state.status === "connected";
	return <View style={{ flex: 1 }}>
		<Header title={t("settings")} onBack={back} backLabel={t("back")} />
		<ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40, gap: 8 }}>
			<Eyebrow>{t("connection")}</Eyebrow>
			<Group>
				<GroupRow first icon="monitor" tint={theme.accent} label={state.bootstrap?.name || t("desktop")} detail={connection ? connection.relay ? `${t("viaRelay")} · ${connection.url}` : connection.url : undefined} trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><StatusDot status={state.status} /><Txt kind="caption" tone="muted">{t(state.status)}</Txt></View>} />
				<GroupRow icon="refresh-cw" tint="#8e8e93" label={t("refresh")} chevron={false} disabled={!online} onPress={refresh} />
			</Group>
			<Eyebrow style={{ marginTop: 18 }}>{t("language")}</Eyebrow>
			<Group>
				<GroupRow first icon="globe" tint="#a970f0" label={t("language")} value={t("languageValue")} onPress={() => setLocale(locale === "zh" ? "en" : "zh")} />
			</Group>
			<Eyebrow style={{ marginTop: 18 }}>{t("about")}</Eyebrow>
			<Group style={{ padding: 16 }}>
				<Txt kind="sub" tone="muted">{t("aboutText")}</Txt>
			</Group>
			<Group style={{ marginTop: 24 }}>
				<GroupRow first icon="log-out" tint={theme.danger} label={t("disconnect")} danger chevron={false} onPress={disconnect} />
			</Group>
		</ScrollView>
	</View>;
}
