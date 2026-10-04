import { Link, Redirect } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMobile } from "../src/store";
import { mobileTranslator } from "../src/i18n";

/**
 * One decision: is there a desktop to show?
 *
 * There used to be a session list here, written for this app — its own rows, its own grouping, its
 * own idea of which conversations are worth listing. It is gone. The desktop already has a list,
 * in a sidebar this phone now displays, and a second one that ordered things differently and could
 * do less was the phone disagreeing with the machine it is a window onto.
 *
 * So this screen either invites you to pair or hands over to `/desk`, and nothing else.
 */
export default function HomeScreen() {
	const t = mobileTranslator();
	const hydrated = useMobile((s) => s.hydrated);
	const connection = useMobile((s) => s.connection);

	// The stored connection is read from secure storage, so there is a moment with no answer yet.
	// Deciding during it would flash the pairing screen at someone who is already paired.
	if (!hydrated) {
		return (
			<View className="flex-1 items-center justify-center bg-shell">
				<ActivityIndicator color="#9a9a9a" />
			</View>
		);
	}

	if (connection) return <Redirect href="/desk" />;

	return (
		<View className="flex-1 items-center justify-center bg-shell px-8">
			<Text className="text-center text-[22px] font-semibold text-ink">{t("home.title")}</Text>
			<Text className="mt-3 text-center text-[13.5px] leading-6 text-ink-muted">
				{t("home.body")}
			</Text>
			<Link href="/pair" asChild>
				<Pressable className="mt-8 rounded-xl bg-ink px-5 py-3 active:opacity-85">
					<Text className="text-[14px] font-medium text-shell">{t("home.start")}</Text>
				</Pressable>
			</Link>
			<Text className="mt-6 text-center text-[12px] leading-5 text-ink-faint">
				{t("home.hint")}
			</Text>
		</View>
	);
}
