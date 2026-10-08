import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Sheet } from "./Sheet.tsx";
import { TodoList } from "./ToolSheet.tsx";
import type { Todo } from "./tools.ts";
import { Icon, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/**
 * 输入框上方一条：计划做到第几项、此刻在做哪一项。点开看整份清单。
 *
 * 全部做完、任务也停了就不再占位置——那份清单已经是历史，在对话里点「更新清单」那一步还看得到。
 */
export function PlanBar({ todos, running, t }: { todos: Todo[]; running: boolean; t: T }) {
	const theme = useTheme();
	const [open, setOpen] = useState(false);
	const done = todos.filter((todo) => todo.status === "completed").length;
	if (!todos.length || (done === todos.length && !running)) return null;
	const active = todos.find((todo) => todo.status === "in_progress");
	return <>
		<Pressable accessibilityRole="button" accessibilityLabel={t("planProgress", { done, total: todos.length })} onPress={() => setOpen(true)} style={({ pressed }) => ({ marginHorizontal: 12, marginBottom: 6, minHeight: 36, borderRadius: 18, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.grouped, borderWidth: 1, borderColor: theme.lineSoft, opacity: pressed ? 0.75 : 1 })}>
			<Icon name="check-square" size={14} color={theme.accent} />
			<Text style={{ color: theme.ink, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{t("planProgress", { done, total: todos.length })}</Text>
			{active && <Text numberOfLines={1} style={{ flex: 1, color: theme.muted, fontSize: 13 }}>{active.activeForm || active.content}</Text>}
			{!active && <View style={{ flex: 1 }} />}
			<View style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: theme.card, overflow: "hidden" }}>
				<View style={{ width: `${(done / todos.length) * 100}%`, height: 4, backgroundColor: theme.success }} />
			</View>
		</Pressable>
		{open && <Sheet title={t("planProgress", { done, total: todos.length })} close={() => setOpen(false)} closeLabel={t("close")}>
			<ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}><TodoList todos={todos} /></ScrollView>
		</Sheet>}
	</>;
}
