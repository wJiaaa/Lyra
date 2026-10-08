import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, BackHandler, Linking, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { RemoteClient, parsePairingCode, type Connection } from "@plume/client-runtime";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { SessionsScreen } from "./SessionsScreen.tsx";
import { ChatScreen } from "./ChatScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { readConnection, saveConnection } from "./connection-store.ts";
import { translate, type Locale } from "./i18n.ts";
import { Banner, Theme, dark, light } from "./ui.tsx";

const client = new RemoteClient();
type Route = "connect" | "sessions" | "chat" | "settings";

export default function App() {
	const theme = useColorScheme() === "light" ? light : dark;
	const [locale, setLocale] = useState<Locale>("zh");
	const t = useMemo(() => translate(locale), [locale]);
	const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
	const [route, setRoute] = useState<Route>("connect");
	const [connection, setConnection] = useState<Connection | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	function report(cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
	async function connect(next: Connection) {
		setBusy(true); setError(null); setConnection(next);
		try { await client.connect(next); await saveConnection(next); setRoute("sessions"); }
		catch (cause) { report(cause); throw cause; }
		finally { setBusy(false); }
	}
	const back = useCallback(() => { setError(null); client.closeSession(); setRoute("sessions"); }, []);
	useEffect(() => {
		void readConnection().then((saved) => { if (saved) void connect(saved).catch(() => undefined); }).catch(report);
		function pair(url: string) { if (url.startsWith("plume://pair")) { try { void connect(parsePairingCode(url)).catch(() => undefined); } catch (cause) { report(cause); } } }
		void Linking.getInitialURL().then((url) => { if (url) pair(url); });
		const links = Linking.addEventListener("url", ({ url }) => pair(url));
		const activity = AppState.addEventListener("change", (status) => { if (status === "active") client.wake(); });
		return () => { links.remove(); activity.remove(); client.disconnect(); };
	}, []);
	useEffect(() => {
		const handler = BackHandler.addEventListener("hardwareBackPress", () => { if (route === "sessions" || route === "connect") return false; back(); return true; });
		return () => handler.remove();
	}, [route, back]);
	useEffect(() => { if (route === "chat" && !state.activeId) setRoute("sessions"); }, [state.activeId, route]);
	// 同一句错误被关掉以后不再弹回来；换了一句才再出现。
	const message = error || state.error;
	useEffect(() => {
		if (!message || route === "connect") return;
		const timer = setTimeout(() => setDismissed(message), 6000);
		return () => clearTimeout(timer);
	}, [message, route]);
	const screen = route === "connect"
		? <ConnectScreen connect={connect} busy={busy} error={message} initial={connection} t={t} />
		: route === "sessions"
		? <SessionsScreen state={state} client={client} onSettings={() => setRoute("settings")} onOpen={(id) => { void client.openSession(id); setRoute("chat"); }} onCreated={() => setRoute("chat")} error={report} t={t} />
		: route === "chat"
		? <ChatScreen key={state.activeId} draft={drafts[state.activeId ?? ""] ?? ""} setDraft={(value) => { const id = state.activeId; if (id) setDrafts((current) => ({ ...current, [id]: value })); }} state={state} client={client} back={back} error={report} t={t} />
		: <SettingsScreen state={state} connection={connection} locale={locale} setLocale={setLocale} refresh={() => void client.refresh().catch(report)} disconnect={() => { client.disconnect(); void saveConnection(null).catch(report); setConnection(null); setRoute("connect"); }} back={back} t={t} />;
	return <SafeAreaProvider><Theme.Provider value={theme}><StatusBar style={theme === dark ? "light" : "dark"} /><SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}><View style={{ flex: 1, width: "100%", maxWidth: 720, alignSelf: "center" }}>
		{screen}
		{route !== "connect" && message && message !== dismissed && <View pointerEvents="box-none" style={{ position: "absolute", top: 8, left: 12, right: 12 }}>
			<View style={{ borderRadius: 14, backgroundColor: theme.bg }}><Banner message={message} onDismiss={() => setDismissed(message)} dismissLabel={t("dismiss")} /></View>
		</View>}
	</View></SafeAreaView></Theme.Provider></SafeAreaProvider>;
}
