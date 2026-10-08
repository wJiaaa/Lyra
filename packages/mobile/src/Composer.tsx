import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Attachment } from "./attachments.ts";
import { Icon, floating, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

function Chip({ label, value, onPress, disabled }: { label: string; value: string; onPress(): void; disabled: boolean }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={6} style={({ pressed }) => ({ height: 32, maxWidth: 190, flexShrink: 1, borderRadius: 12, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: pressed ? theme.card : "transparent", opacity: disabled ? 0.4 : 1 })}>
		<Text numberOfLines={1} style={{ flexShrink: 1, color: theme.muted, fontSize: 13, fontWeight: "500" }}>{value}</Text>
		<Icon name="chevron-down" size={12} color={theme.faint} />
	</Pressable>;
}

/**
 * 一张卡片：上面是待发的图和字，下面一排是加图、这条消息会用的模型和思考档位，最右是发送。
 *
 * 发送和停止共用一个位置：任务在跑、框里没字时它是停止，开始打字它变回发送。两颗按钮并排
 * 时，跑着的任务旁边永远有一颗按不了的发送，而真正想按的停止被挤到了中间。
 *
 * 停止画成反色圆（正文色底、页面色方块），不用红：红色实心圆在输入框角上一直亮着，像一个报错；
 * 停止是常规操作，反色已经足够醒目。
 */
export function Composer({ draft, setDraft, attachments, attach, detach, canAttach, send, stop, sending, running, online, ready, model, thinking, pickModel, pickThinking, t }: { draft: string; setDraft(value: string): void; attachments: Attachment[]; attach(): void; detach(index: number): void; canAttach: boolean; send(): void; stop(): void; sending: boolean; running: boolean; online: boolean; ready: boolean; model: string; thinking: string | null; pickModel(): void; pickThinking(): void; t: T }) {
	const theme = useTheme();
	const filled = !!draft.trim() || attachments.length > 0;
	const stopping = running && !filled;
	const canSend = online && ready && !sending && filled;
	const active = stopping ? online : canSend;
	return <View style={[floating(theme), { marginHorizontal: 12, marginTop: 4, marginBottom: 8, borderRadius: 26, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8 }]}>
		{attachments.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 8, paddingBottom: 2 }}>
			{attachments.map((image, index) => <View key={image.uri}>
				<Image accessibilityLabel={t("image")} source={{ uri: image.uri }} style={{ width: 58, height: 58, borderRadius: 12, backgroundColor: theme.card }} />
				<Pressable accessibilityRole="button" accessibilityLabel={t("removeImage")} disabled={sending} onPress={() => detach(index)} hitSlop={8} style={{ position: "absolute", top: -5, right: -5, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.elevated, borderWidth: 1, borderColor: theme.line }}>
					<Icon name="x" size={11} color={theme.ink} />
				</Pressable>
			</View>)}
		</ScrollView>}
		<TextInput
			accessibilityLabel={t("prompt")}
			placeholder={t("prompt")}
			placeholderTextColor={theme.faint}
			selectionColor={theme.accent}
			value={draft}
			onChangeText={setDraft}
			multiline
			editable={online && ready && !sending}
			style={{ minHeight: 44, maxHeight: 160, paddingHorizontal: 8, paddingTop: 11, paddingBottom: 6, color: theme.strong, fontSize: 16, lineHeight: 22 }}
		/>
		<View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
			{canAttach && <Pressable accessibilityRole="button" accessibilityLabel={t("attach")} disabled={!online || !ready || sending} onPress={attach} hitSlop={6} style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line, backgroundColor: pressed ? theme.card : "transparent", opacity: !online || !ready || sending ? 0.4 : 1 })}>
				<Icon name="plus" size={18} color={theme.muted} />
			</Pressable>}
			<Chip label={t("model")} value={model} onPress={pickModel} disabled={!online || !ready} />
			{thinking !== null && <Chip label={t("thinking")} value={thinking} onPress={pickThinking} disabled={!online || !ready} />}
			<View style={{ flex: 1 }} />
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={t(stopping ? "stop" : "send")}
				accessibilityState={{ disabled: !active, busy: sending }}
				disabled={!active}
				onPress={stopping ? stop : send}
				hitSlop={6}
				style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: stopping ? theme.strong : active ? theme.accent : theme.card, opacity: stopping && !online ? 0.4 : pressed ? 0.75 : 1 })}
			>
				{sending ? <ActivityIndicator size="small" color={theme.onAccent} /> : stopping ? <View style={{ width: 11, height: 11, borderRadius: 3, backgroundColor: theme.elevated }} /> : <Icon name="arrow-up" size={18} color={active ? theme.onAccent : theme.faint} />}
			</Pressable>
		</View>
	</View>;
}
