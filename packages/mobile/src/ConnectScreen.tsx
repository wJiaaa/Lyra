import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { normalizeConnection, parsePairingCode, type Connection } from "@plume/client-runtime";
import { ScanScreen } from "./ScanScreen.tsx";
import { Banner, Button, Eyebrow, Field, Group, Icon, Txt, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

export function ConnectScreen({ connect, busy, error, initial, t }: { connect(connection: Connection): Promise<void>; busy: boolean; error: string | null; initial: Connection | null; t: T }) {
	const theme = useTheme();
	const [url, setUrl] = useState(initial?.url ?? "");
	const [token, setToken] = useState(initial?.token ?? "");
	const [relay, setRelay] = useState(initial?.relay ?? false);
	const [scan, setScan] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	useEffect(() => { if (initial) { setUrl(initial.url); setToken(initial.token); setRelay(initial.relay ?? false); } }, [initial]);
	async function submit(code?: string) {
		setLocalError(null);
		try {
			await connect(code ? parsePairingCode(code) : normalizeConnection(url, token, relay));
			setScan(false);
		} catch (cause) {
			setScan(false);
			setLocalError(cause instanceof Error ? cause.message : t("connectFailed"));
		}
	}
	if (scan) return <ScanScreen submit={(code) => void submit(code)} close={() => setScan(false)} busy={busy} t={t} />;
	const message = localError || error;
	// 不套 KeyboardAvoidingView：它只把滚动区压矮，不会把输入框滚上来，下半屏的地址和令牌会被键盘盖住。
	// automaticallyAdjustKeyboardInsets 按键盘的遮挡加底部留白，并把有焦点的输入框滚到键盘上方（iOS）；
	// Android 靠 app.json 的 softwareKeyboardLayoutMode: resize，ScrollView 自己会滚到焦点。
	return <ScrollView style={{ flex: 1 }} automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 20, paddingVertical: 32, gap: 28, width: "100%", maxWidth: 460, alignSelf: "center" }}>
		<View style={{ gap: 14 }}>
			<View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: theme.grouped, alignItems: "center", justifyContent: "center" }}><Icon name="feather" size={28} color={theme.accent} /></View>
			<Txt kind="title" tone="strong" style={{ fontSize: 32, lineHeight: 38 }}>Plume</Txt>
			<Txt tone="muted">{t("tagline")}</Txt>
		</View>
		<Pressable accessibilityRole="button" accessibilityLabel={t("scan")} disabled={busy} onPress={() => setScan(true)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: 20, backgroundColor: theme.accent, opacity: busy ? 0.5 : pressed ? 0.85 : 1 })}>
			<View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}><Icon name="maximize" size={20} color={theme.onAccent} /></View>
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={{ color: theme.onAccent, fontSize: 16, fontWeight: "600" }}>{t("scan")}</Text>
				<Text style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, lineHeight: 17 }}>{t("scanDetail")}</Text>
			</View>
			<Icon name="chevron-right" size={18} color={theme.onAccent} />
		</Pressable>
		<View style={{ gap: 8 }}>
			<Eyebrow>{t("manual")}</Eyebrow>
			<Group style={{ padding: 16, gap: 14 }}>
				<View style={{ flexDirection: "row", padding: 3, borderRadius: 12, backgroundColor: theme.card }}>
					{([false, true] as const).map((via) => <Pressable key={String(via)} accessibilityRole="button" accessibilityLabel={t(via ? "viaRelay" : "direct")} accessibilityState={{ selected: relay === via }} onPress={() => setRelay(via)} style={{ flex: 1, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: relay === via ? theme.elevated : "transparent" }}>
						<Text style={{ fontSize: 14, fontWeight: "600", color: relay === via ? theme.ink : theme.muted }}>{t(via ? "viaRelay" : "direct")}</Text>
					</Pressable>)}
				</View>
				<View style={{ gap: 7 }}>
					<Txt kind="caption" tone="muted" weight="500">{t(relay ? "relayAddress" : "address")}</Txt>
					<Field accessibilityLabel={t(relay ? "relayAddress" : "address")} placeholder={relay ? "wss://relay.example.com" : "http://192.168.1.20:4517"} value={url} onChangeText={(value) => { if (value.startsWith("plume://")) void submit(value); else setUrl(value); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} />
				</View>
				<View style={{ gap: 7 }}>
					<Txt kind="caption" tone="muted" weight="500">{t("token")}</Txt>
					<Field accessibilityLabel={t("token")} placeholder="••••••••" value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy} returnKeyType="go" onSubmitEditing={() => void submit()} />
				</View>
				<Txt kind="caption" tone="faint">{t("pasteHint")}</Txt>
				{message && <Banner message={message} />}
				<Button label={busy ? t("connecting") : t("connect")} busy={busy} disabled={!url.trim() || !token.trim()} onPress={() => void submit()} />
			</Group>
		</View>
		<View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 4 }}>
			<Icon name="lock" size={13} color={theme.faint} />
			<Txt kind="caption" tone="faint" style={{ flex: 1 }}>{t("secure")}</Txt>
		</View>
	</ScrollView>;
}
