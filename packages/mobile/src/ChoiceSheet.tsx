import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Sheet } from "./Sheet.tsx";
import { Icon, ProjectMark, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/** `mark` 给了就在行首画项目标记（空串画「未关联项目」的空心方块）。 */
export interface Choice { value: string; label: string; detail?: string; mark?: string }

/** 一列互斥选项，放在一张分组卡里；点中即收起，不另设「完成」。 */
export function ChoiceList({ options, value, choose }: { options: Choice[]; value: string; choose(value: string): void }) {
	const theme = useTheme();
	// 只出现在底部面板里：面板是浮面色，这一组要比它再亮一档才分得出来，所以用卡片色而不是分组色。
	return <View style={{ borderRadius: 14, overflow: "hidden", backgroundColor: theme.card }}>
		{options.map((option, index) => {
			const checked = value === option.value;
			return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked }} onPress={() => choose(option.value)} style={({ pressed }) => [{ minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 }, pressed && { opacity: 0.6 }]}>
				{index > 0 && <View style={{ position: "absolute", top: 0, right: 0, left: option.mark !== undefined ? 46 : 16, height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />}
				{option.mark !== undefined && <ProjectMark name={option.mark || undefined} size={20} />}
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
