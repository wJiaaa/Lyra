import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import type { SessionMeta } from "@plume/client-runtime";
import { Sheet } from "./Sheet.tsx";
import { Eyebrow, Field, Group, GroupRow, Icon, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/**
 * 一个会话能做的事：聊天页右上角和列表长按共用。改名只在聊天页给（运行时的改名针对当前打开的会话）。
 *
 * 改名的确认钮贴在框内右侧并且常驻：名字没变时是灰的，改了才亮——而不是在框下面再横一条整宽按钮，
 * 那样框和按钮读起来是两件事。归档可以随时恢复，不算危险操作，不用红字。
 */
export function SessionActions({ title, meta, running, online, rename, archive, close, error, t }: { title?: string; meta: SessionMeta; running: boolean; online: boolean; rename?: (title: string) => Promise<void>; archive(): Promise<void>; close(): void; error(cause: unknown): void; t: T }) {
	const theme = useTheme();
	const [name, setName] = useState(meta.title ?? "");
	const [busy, setBusy] = useState<"rename" | "archive" | null>(null);
	const next = name.trim();
	const renamable = !!rename && online && !!next && next !== meta.title && !busy;
	const archived = !!meta.archived;
	return <Sheet title={title ?? t("more")} close={close} closeLabel={t("close")}>
		{(dismiss) => {
			function submit() {
				if (!renamable) return;
				setBusy("rename");
				void rename!(next).then(dismiss).catch(error).finally(() => setBusy(null));
			}
			return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, gap: 20 }}>
				{rename && <View style={{ gap: 8 }}>
					<Eyebrow>{t("title")}</Eyebrow>
					<Field accessibilityLabel={t("title")} placeholder={t("title")} value={name} onChangeText={setName} onSubmitEditing={submit} returnKeyType="done" trailing={<Pressable
						accessibilityRole="button"
						accessibilityLabel={t("rename")}
						accessibilityState={{ disabled: !renamable, busy: busy === "rename" }}
						disabled={!renamable}
						onPress={submit}
						hitSlop={6}
						style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: renamable || busy === "rename" ? theme.accent : theme.grouped, opacity: pressed ? 0.75 : 1 })}
					>
						{busy === "rename" ? <ActivityIndicator size="small" color={theme.onAccent} /> : <Icon name="check" size={18} color={renamable ? theme.onAccent : theme.faint} />}
					</Pressable>} />
				</View>}
				<Group style={{ backgroundColor: theme.card }}>
					<GroupRow
						first
						icon={archived ? "rotate-ccw" : "archive"}
						tint={archived ? theme.accent : theme.warning}
						label={t(archived ? "restore" : "archive")}
						detail={t(archived ? "restoreHint" : running ? "archiveRunning" : "archiveHint")}
						chevron={false}
						disabled={!online || running || !!busy}
						trailing={busy === "archive" ? <ActivityIndicator size="small" color={theme.muted} /> : undefined}
						onPress={() => { setBusy("archive"); void archive().then(dismiss).catch(error).finally(() => setBusy(null)); }}
					/>
				</Group>
			</ScrollView>;
		}}
	</Sheet>;
}
