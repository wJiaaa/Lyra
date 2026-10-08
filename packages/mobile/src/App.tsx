import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Animated, AppState, BackHandler, Easing, Linking, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { RemoteClient, parsePairingCode, type Connection } from "@plume/client-runtime";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { SessionsScreen } from "./SessionsScreen.tsx";
import { ChatScreen } from "./ChatScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { readConnection, saveConnection } from "./connection-store.ts";
import { translate, type Locale } from "./i18n.ts";
import { Banner, Theme, dark, light, nativeDriver } from "./ui.tsx";

const client = new RemoteClient();
type Route = "connect" | "sessions" | "chat" | "settings";
type Nav = { route: Route; from: number };
const DEPTH: Record<Route, number> = { connect: 0, sessions: 1, chat: 2, settings: 2 };
/** 去 `next`，顺带记下方向：比当前深就是往里走（+1），浅就是返回（-1）。 */
const go = (next: Route) => (current: Nav): Nav => current.route === next ? current : { route: next, from: Math.sign(DEPTH[next] - DEPTH[current.route]) };

/**
 * 换页时新的一页从前进的方向滑进来：往里走从右边来，返回从左边来，`from` 为 0 时（刚打开应用）直接就位。
 * 旧页不留着陪它退场：聊天页带着长列表和输入框，两页同时挂载的代价比这一小段位移大得多；
 * 位移只有 48px，配着淡入，空出来的那一窄条看不出来。
 */
function Stage({ from, children }: { from: number; children: ReactNode }) {
	const value = useRef(new Animated.Value(from ? 0 : 1)).current;
	useEffect(() => {
		Animated.timing(value, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver }).start();
	}, [value]);
	return <Animated.View testID="page" style={{ flex: 1, opacity: value, transform: [{ translateX: value.interpolate({ inputRange: [0, 1], outputRange: [from * 48, 0] }) }] }}>{children}</Animated.View>;
}

export default function App() {
	const theme = useColorScheme() === "light" ? light : dark;
	const [locale, setLocale] = useState<Locale>("zh");
	const t = useMemo(() => translate(locale), [locale]);
	const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
	const [nav, setNav] = useState<Nav>({ route: "connect", from: 0 });
	const route = nav.route;
	const [connection, setConnection] = useState<Connection | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	function report(cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
	async function connect(next: Connection) {
		setBusy(true); setError(null); setConnection(next);
		try { await client.connect(next); await saveConnection(next); setNav(go("sessions")); }
		catch (cause) { report(cause); throw cause; }
		finally { setBusy(false); }
	}
	const back = useCallback(() => { setError(null); client.closeSession(); setNav(go("sessions")); }, []);
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
	useEffect(() => { if (route === "chat" && !state.activeId) setNav(go("sessions")); }, [state.activeId, route]);
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
		? <SessionsScreen state={state} client={client} onSettings={() => setNav(go("settings"))} onOpen={(id) => { void client.openSession(id); setNav(go("chat")); }} onCreated={() => setNav(go("chat"))} error={report} t={t} />
		: route === "chat"
		? <ChatScreen key={state.activeId} draft={drafts[state.activeId ?? ""] ?? ""} setDraft={(value) => { const id = state.activeId; if (id) setDrafts((current) => ({ ...current, [id]: value })); }} state={state} client={client} back={back} error={report} t={t} />
		: <SettingsScreen state={state} connection={connection} locale={locale} setLocale={setLocale} refresh={() => void client.refresh().catch(report)} disconnect={() => { client.disconnect(); void saveConnection(null).catch(report); setConnection(null); setNav(go("connect")); }} back={back} t={t} />;
	return <SafeAreaProvider><Theme.Provider value={theme}><StatusBar style={theme === dark ? "light" : "dark"} /><SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}><View style={{ flex: 1, width: "100%", maxWidth: 720, alignSelf: "center" }}>
		<Stage key={route} from={nav.from}>{screen}</Stage>
		{route !== "connect" && message && message !== dismissed && <View pointerEvents="box-none" style={{ position: "absolute", top: 8, left: 12, right: 12 }}>
			<View style={{ borderRadius: 14, backgroundColor: theme.bg }}><Banner message={message} onDismiss={() => setDismissed(message)} dismissLabel={t("dismiss")} /></View>
		</View>}
	</View></SafeAreaView></Theme.Provider></SafeAreaProvider>;
}
