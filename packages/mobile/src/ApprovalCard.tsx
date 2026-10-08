import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ApprovalDecision, SessionSnapshot } from "@plume/client-runtime";
import { Button, Icon, Txt, floating, styles, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/**
 * 停在输入框上方的授权或提问。
 *
 * 不放进消息流的末尾：Agent 正等着它，而消息流会被往上翻走；停靠在底部意味着这件事一直在
 * 手边，答完就消失，输入框回到原位。
 */
export function ApprovalCard({ request, answer, disabled, error, t }: { request: SessionSnapshot["pendingApprovals"][number]; answer(decision: ApprovalDecision): Promise<void>; disabled: boolean; error(cause: unknown): void; t: T }) {
	const theme = useTheme();
	const [selected, setSelected] = useState<string[]>([]);
	const [custom, setCustom] = useState("");
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!request.expiresAt) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [request.expiresAt]);
	const left = request.expiresAt ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : null;
	const expired = left === 0;
	const options = request.options ?? [];
	const interactive = request.kind === "interactive";
	const multi = request.selectionMode === "multi";
	const inert = disabled || busy || expired;
	function submit(decision: ApprovalDecision) {
		setBusy(true);
		void answer(decision).catch(error).finally(() => setBusy(false));
	}
	function reply() {
		const typed = custom.trim();
		const values = [...selected, ...(typed ? [typed] : [])];
		submit({ answer: multi ? values : typed || selected[0] });
	}
	return <View style={[floating(theme), { marginHorizontal: 12, marginBottom: 6, borderRadius: 22, maxHeight: "100%" }]}>
		<ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
			<View style={[styles.row, { gap: 8 }]}>
				<View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: theme.warningSoft, alignItems: "center", justifyContent: "center" }}><Icon name={interactive ? "help-circle" : "shield"} size={13} color={theme.warning} /></View>
				<Txt kind="eyebrow" tone="warning" style={{ flex: 1 }}>{t(interactive ? "question" : "approval")}</Txt>
				{left !== null && !expired && <Txt kind="caption" tone={left <= 30 ? "danger" : "muted"}>{left >= 60 ? t("expiresInMinutes", { n: Math.ceil(left / 60) }) : t("expiresIn", { n: left })}</Txt>}
			</View>
			<Txt kind="heading" tone="strong" selectable style={{ fontSize: 18, lineHeight: 24, fontWeight: "700" }}>{request.title}</Txt>
			{request.detail && <Txt kind="sub" tone="muted" selectable>{request.detail}</Txt>}
			{request.reason && <Txt kind="caption" tone="muted" selectable>{request.reason}</Txt>}
			{options.length > 0 && <View style={{ gap: 8, marginTop: 2 }}>
				{options.map((option) => {
					const label = typeof option === "string" ? option : option.label;
					const description = typeof option === "string" ? undefined : option.description;
					const checked = selected.includes(label);
					return <Pressable
						key={label}
						accessibilityLabel={label}
						accessibilityRole={multi ? "checkbox" : "radio"}
						accessibilityState={{ checked, disabled: inert }}
						disabled={inert}
						onPress={() => setSelected(multi ? checked ? selected.filter((value) => value !== label) : [...selected, label] : [label])}
						style={({ pressed }) => [styles.row, { minHeight: 50, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 14, borderWidth: 1, borderColor: checked ? theme.accent : "transparent", backgroundColor: checked ? theme.accentSoft : theme.card, opacity: pressed ? 0.7 : 1 }]}
					>
						<View style={{ flex: 1, gap: 2 }}>
							<Text style={{ color: theme.ink, fontSize: 15, fontWeight: checked ? "600" : "400" }}>{label}</Text>
							{description && <Txt kind="caption" tone="muted">{description}</Txt>}
						</View>
						<Icon name={checked ? multi ? "check-square" : "check-circle" : multi ? "square" : "circle"} size={18} color={checked ? theme.accent : theme.faint} />
					</Pressable>;
				})}
			</View>}
			{interactive && (request.allowCustomInput || !options.length) && <TextInput
				accessibilityLabel={t("custom")}
				placeholder={t("custom")}
				placeholderTextColor={theme.faint}
				selectionColor={theme.accent}
				value={custom}
				onChangeText={setCustom}
				multiline
				editable={!inert}
				style={{ minHeight: 48, maxHeight: 120, borderRadius: 14, backgroundColor: theme.card, color: theme.ink, fontSize: 15, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 13 }}
			/>}
			{expired ? <Txt kind="sub" tone="danger">{t("expired")}</Txt> : interactive ? <View style={[styles.row, { gap: 8, marginTop: 4 }]}>
				{request.allowSkip && <Button label={t("skip")} variant="secondary" small disabled={disabled || busy} onPress={() => submit("skip")} />}
				<Button label={t("answer")} small grow busy={busy} disabled={disabled || (!selected.length && !custom.trim())} onPress={reply} />
			</View> : <View style={{ gap: 8, marginTop: 4 }}>
				<View style={[styles.row, { gap: 8 }]}>
					<Button label={t("reject")} variant="danger" small grow disabled={disabled || busy} onPress={() => submit("reject")} />
					<Button label={t("allow")} small grow busy={busy} disabled={disabled} onPress={() => submit("once")} />
				</View>
				{!request.escalation && <Button label={t("always")} variant="secondary" small disabled={disabled || busy} onPress={() => submit("always")} />}
			</View>}
		</ScrollView>
	</View>;
}
