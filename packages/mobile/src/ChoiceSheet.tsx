import { Pressable, ScrollView, Text, View } from "react-native";
import { Sheet } from "./Sheet.tsx";
import { Icon, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

export interface Choice { value: string; label: string; detail?: string }

/** 一列互斥选项，放在一张分组卡里；点中即收起，不另设「完成」。 */
export function ChoiceList({ options, value, choose }: { options: Choice[]; value: string; choose(value: string): void }) {
	const theme = useTheme();
	return <View style={{ borderRadius: 20, overflow: "hidden", backgroundColor: theme.card }}>
		{options.map((option, index) => {
			const checked = value === option.value;
			return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked }} onPress={() => choose(option.value)} style={({ pressed }) => [{ minHeight: 54, paddingHorizontal: 16, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 12 }, index > 0 && { borderTopWidth: 1, borderTopColor: theme.line }, pressed && { backgroundColor: theme.elevated }]}>
				<View style={{ flex: 1, minWidth: 0 }}>
					<Text numberOfLines={1} style={{ color: theme.ink, fontSize: 16, fontWeight: checked ? "600" : "400" }}>{option.label}</Text>
					{option.detail && <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 13, marginTop: 2 }}>{option.detail}</Text>}
				</View>
				{checked && <Icon name="check" size={18} color={theme.accent} />}
			</Pressable>;
		})}
	</View>;
}

export function ChoiceSheet({ title, options, value, choose, close, t }: { title: string; options: Choice[]; value: string; choose(value: string): void; close(): void; t: T }) {
	return <Sheet title={title} close={close} closeLabel={t("close")}>
		{(dismiss) => <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}>
			<ChoiceList options={options} value={value} choose={(next) => { choose(next); dismiss(); }} />
		</ScrollView>}
	</Sheet>;
}
