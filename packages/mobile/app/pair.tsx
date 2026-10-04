import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pingDesktop, pingRelay } from "../src/connection";
import { parsePairingCode } from "../src/pairing";
import { useMobile } from "../src/store";
import { mobileTranslator } from "../src/i18n";

export default function PairScreen() {
	const t = mobileTranslator();
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const connection = useMobile((s) => s.connection);
	const pair = useMobile((s) => s.pair);
	const unpair = useMobile((s) => s.unpair);

	const [host, setHost] = useState(connection?.host ?? "");
	const [port, setPort] = useState(String(connection?.port ?? 4517));
	const [token, setToken] = useState(connection?.token ?? "");
	const [tls, setTls] = useState(Boolean(connection?.tls));
	/*
	 * Whether this address is a relay rather than the desktop itself.
	 *
	 * Only a pairing code can say so — the three fields below describe a host, and a relay is not
	 * one. It is kept in state rather than derived because it changes what "connect" even means:
	 * against a relay there is no sync server to ask, only a room to be let into.
	 */
	const [relay, setRelay] = useState(Boolean(connection?.relay));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	async function pastePairingUrl() {
		const text = await Clipboard.getStringAsync().catch(() => "");
		// The same parser the camera uses, so a pasted code and a scanned one cannot disagree
		// about what a code means — including the relay and tls shapes the fields cannot show.
		const parsed = parsePairingCode(text);
		if (!parsed.ok) {
			setMessage({ tone: "error", text: t("pair.clipboardMissing", { reason: parsed.reason }) });
			return;
		}
		setHost(parsed.connection.host);
		setPort(String(parsed.connection.port));
		setToken(parsed.connection.token);
		setTls(Boolean(parsed.connection.tls));
		setRelay(Boolean(parsed.connection.relay));
		setMessage({
			tone: "ok",
			text: parsed.connection.relay ? t("pair.pastedRelay") : t("pair.pasted"),
		});
	}

	async function testAndSave() {
		setBusy(true);
		setMessage(null);
		try {
			const parsedPort = Number(port);
			if (!host.trim() || !Number.isFinite(parsedPort) || !token.trim()) {
				setMessage({ tone: "error", text: t("pair.required") });
				return;
			}

			/*
			 * A relay is checked differently, because it is not a sync server: it answers none of
			 * the app's routes and has no opinion about the token. All it can say is whether the
			 * room opened, which is the only thing worth knowing before saving.
			 */
			const reachable = relay
				? await pingRelay(host.trim(), parsedPort, tls, token.trim())
				: await pingDesktop(host.trim(), parsedPort, tls);
			if (!reachable) {
				setMessage({
					tone: "error",
					text: relay
						? t("pair.relayFailed", { address: `${host}:${port}` })
						: t("pair.directFailed", { address: `${host}:${port}` }),
				});
				return;
			}

			const ok = await pair({ host: host.trim(), port: parsedPort, token: token.trim(), tls, relay });
			if (ok) router.replace("/desk");
			else setMessage({ tone: "error", text: t("pair.tokenWrong") });
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView className="flex-1 bg-shell" behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<ScrollView contentContainerStyle={{ paddingTop: 20, paddingLeft: 20 + insets.left, paddingRight: 20 + insets.right, paddingBottom: 48 + insets.bottom }}>
				<Text className="text-[13.5px] leading-6 text-ink-muted">
					{t("pair.intro")}
				</Text>

				{/*
				 * The scan button is the method; everything under it is the fallback.
				 *
				 * Typing a thirty-two character token on a phone keyboard is where pairing went
				 * wrong, and a mistyped one fails without saying which character was wrong.
				 */}
				<Pressable
					onPress={() => router.push("/scan")}
					className="mt-4 flex-row items-center justify-center gap-2 rounded-xl bg-ink py-3.5 active:opacity-85"
				>
					<Text className="text-[15px] font-medium text-shell">{t("pair.scan")}</Text>
				</Pressable>

				<Pressable
					onPress={() => void pastePairingUrl()}
					className="mt-2.5 items-center rounded-xl border border-dashed border-line py-3 active:bg-card-hover"
				>
					<Text className="text-[13px] text-ink-muted">{t("pair.paste")}</Text>
				</Pressable>

				<Text className="mt-5 text-[12px] text-ink-faint">{t("pair.manual")}</Text>

				<Field label={t("pair.address")}>
					<TextInput
						value={host}
						onChangeText={setHost}
						placeholder="192.168.1.10"
						placeholderTextColor="#6e6e6e"
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="numbers-and-punctuation"
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
					/>
				</Field>

				<Field label={t("pair.port")}>
					<TextInput
						value={port}
						onChangeText={setPort}
						placeholder="4517"
						placeholderTextColor="#6e6e6e"
						keyboardType="number-pad"
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
					/>
				</Field>

				<Field label={t("pair.token")}>
					<TextInput
						value={token}
						onChangeText={setToken}
						placeholder={t("pair.tokenPlaceholder")}
						placeholderTextColor="#6e6e6e"
						autoCapitalize="none"
						autoCorrect={false}
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
					/>
				</Field>

				{message && (
					<View
						className={`mt-4 rounded-xl border px-3.5 py-3 ${
							message.tone === "ok" ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"
						}`}
					>
						<Text className={`text-[13px] leading-5 ${message.tone === "ok" ? "text-ok" : "text-danger"}`}>
							{message.text}
						</Text>
					</View>
				)}

				<Pressable
					disabled={busy}
					onPress={() => void testAndSave()}
					className="mt-6 h-12 items-center justify-center rounded-xl bg-ink active:opacity-85 disabled:opacity-50"
				>
					{busy ? <ActivityIndicator color="#171717" /> : <Text className="text-[15px] font-medium text-shell">{t("pair.connect")}</Text>}
				</Pressable>

				{connection && (
					<Pressable
						onPress={() => {
							void unpair();
							router.back();
						}}
						className="mt-3 h-12 items-center justify-center rounded-xl border border-line active:bg-card-hover"
					>
						<Text className="text-[14px] text-danger">{t("pair.disconnect")}</Text>
					</Pressable>
				)}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<View className="mt-4">
			<Text className="mb-1.5 text-[12.5px] text-ink-muted">{label}</Text>
			{children}
		</View>
	);
}
