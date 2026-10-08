import { createContext, useContext, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";

// 色值与桌面 tokens.css 同源：同一份会话在两端应当是同一种底色和同一个强调色。
export const dark = {
	bg: "#171717", grouped: "#1f1f1f", card: "#242424", elevated: "#2c2c2c", line: "#2e2e2e", lineSoft: "#262626",
	ink: "#d4d4d4", strong: "#f2f2f2", muted: "#888888", faint: "#5c5c5c",
	accent: "#339cff", accentSoft: "rgba(51,156,255,0.14)", success: "#3ecf8e", successSoft: "rgba(62,207,142,0.13)", warning: "#e5a33a",
	danger: "#f2555a", dangerSoft: "rgba(242,85,90,0.12)", backdrop: "rgba(0,0,0,0.5)", onAccent: "#ffffff",
};
export const light: typeof dark = {
	bg: "#f6f6f6", grouped: "#ffffff", card: "#ededed", elevated: "#ffffff", line: "#e0e0e0", lineSoft: "#ebebeb",
	ink: "#252525", strong: "#111111", muted: "#6e6e6e", faint: "#a6a6a6",
	accent: "#087ee0", accentSoft: "rgba(8,126,224,0.10)", success: "#158357", successSoft: "rgba(21,131,87,0.10)", warning: "#b26b00",
	danger: "#d13740", dangerSoft: "rgba(209,55,64,0.09)", backdrop: "rgba(0,0,0,0.25)", onAccent: "#ffffff",
};

export const Theme = createContext(dark);
export const useTheme = () => useContext(Theme);
export type IconName = ComponentProps<typeof Feather>["name"];
export const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
// Web 上 Animated 没有原生驱动，开着会每次打一条警告。
export const nativeDriver = Platform.OS !== "web";

export function Icon({ name, color, size = 20 }: { name: IconName; color?: string; size?: number }) {
	const theme = useTheme();
	return <Feather name={name} size={size} color={color ?? theme.ink} accessible={false} accessibilityElementsHidden />;
}

const TYPE = {
	title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6 },
	heading: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
	body: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
	sub: { fontSize: 14, lineHeight: 19, fontWeight: "400" },
	caption: { fontSize: 13, lineHeight: 17, fontWeight: "400" },
	eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase" },
} satisfies Record<string, TextStyle>;
type Tone = "ink" | "strong" | "muted" | "faint" | "accent" | "danger" | "success" | "warning";

export function Txt({ children, kind = "body", tone = "ink", weight, lines, selectable, style }: { children: ReactNode; kind?: keyof typeof TYPE; tone?: Tone; weight?: TextStyle["fontWeight"]; lines?: number; selectable?: boolean; style?: StyleProp<TextStyle> }) {
	const theme = useTheme();
	return <Text numberOfLines={lines} selectable={selectable} style={[TYPE[kind], { color: theme[tone] }, weight ? { fontWeight: weight } : null, style]}>{children}</Text>;
}

type Variant = "primary" | "secondary" | "danger" | "plain";
export function Button({ label, icon, onPress, variant = "primary", small = false, disabled = false, busy = false, grow = false }: { label: string; icon?: IconName; onPress(): void; variant?: Variant; small?: boolean; disabled?: boolean; busy?: boolean; grow?: boolean }) {
	const theme = useTheme();
	const inert = disabled || busy;
	// 主按钮不可用时换成灰底，而不是把蓝色调淡：淡蓝压在深色底上是一块发脏的灰蓝，看不出是「还不能按」。
	const greyed = variant === "primary" && disabled && !busy;
	const fill = greyed ? theme.card : { primary: theme.accent, secondary: theme.card, danger: theme.dangerSoft, plain: "transparent" }[variant];
	const color = greyed ? theme.faint : { primary: theme.onAccent, secondary: theme.ink, danger: theme.danger, plain: theme.accent }[variant];
	return <Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		accessibilityState={{ disabled: inert, busy }}
		disabled={inert}
		onPress={onPress}
		style={({ pressed }) => [styles.button, small && styles.buttonSmall, grow && { flex: 1 }, { backgroundColor: fill, opacity: greyed ? 1 : inert ? 0.4 : pressed ? 0.75 : 1 }]}
	>
		{busy ? <ActivityIndicator size="small" color={color} /> : icon ? <Icon name={icon} color={color} size={small ? 16 : 18} /> : null}
		<Text style={{ color, fontSize: small ? 14 : 16, fontWeight: "600" }}>{label}</Text>
	</Pressable>;
}

export function IconButton({ name, label, onPress, disabled = false, filled = false, color, size = 20 }: { name: IconName; label: string; onPress(): void; disabled?: boolean; filled?: boolean; color?: string; size?: number }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.iconButton, filled && { backgroundColor: theme.card }, { opacity: disabled ? 0.35 : pressed ? 0.55 : 1 }]}>
		<Icon name={name} color={color} size={size} />
	</Pressable>;
}

export function Field({ icon, style, ...props }: TextInputProps & { icon?: IconName }) {
	const theme = useTheme();
	return <View style={[styles.field, { backgroundColor: theme.card }, props.multiline && { alignItems: "flex-start" }]}>
		{icon && <Icon name={icon} size={17} color={theme.muted} />}
		<TextInput placeholderTextColor={theme.faint} selectionColor={theme.accent} {...props} style={[styles.fieldInput, { color: theme.ink }, style]} />
	</View>;
}

/** 小号大写的分组名。字段标签和分组标题都用它，让一页里只有一种「这是标签」的写法。 */
export function Eyebrow({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	return <Txt kind="eyebrow" tone="muted" style={[{ paddingHorizontal: 4 }, style]}>{children}</Txt>;
}

export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const theme = useTheme();
	return <View style={[styles.group, { backgroundColor: theme.grouped }, style]}>{children}</View>;
}

export function GroupRow({ icon, label, value, detail, onPress, danger = false, chevron = !!onPress, first = false, disabled = false, trailing }: { icon?: IconName; label: string; value?: string; detail?: string; onPress?: () => void; danger?: boolean; chevron?: boolean; first?: boolean; disabled?: boolean; trailing?: ReactNode }) {
	const theme = useTheme();
	const ink = danger ? theme.danger : theme.ink;
	const body = <>
		{icon && <Icon name={icon} size={18} color={danger ? theme.danger : theme.muted} />}
		<View style={{ flex: 1, minWidth: 0 }}>
			<Text numberOfLines={1} style={{ color: ink, fontSize: 16, lineHeight: 22 }}>{label}</Text>
			{detail && <Text numberOfLines={2} style={{ color: theme.muted, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{detail}</Text>}
		</View>
		{value && <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 15, maxWidth: 180 }}>{value}</Text>}
		{trailing}
		{chevron && <Icon name="chevron-right" size={17} color={theme.faint} />}
	</>;
	const frame = [styles.groupRow, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }];
	if (!onPress) return <View style={frame}>{body}</View>;
	return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [...frame, { opacity: disabled ? 0.4 : 1 }, pressed && { backgroundColor: theme.card }]}>{body}</Pressable>;
}

export type Status = "offline" | "connecting" | "connected" | "reconnecting";
/** 连上是绿点；正在连时点外有一圈慢慢散开的光，好让「还在努力」和「已经断了」看得出区别。 */
export function StatusDot({ status, size = 8 }: { status: Status; size?: number }) {
	const theme = useTheme();
	const color = status === "connected" ? theme.success : status === "offline" ? theme.danger : theme.warning;
	const pulse = useRef(new Animated.Value(0)).current;
	const busy = status === "connecting" || status === "reconnecting";
	useEffect(() => {
		if (!busy) { pulse.setValue(0); return; }
		const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1100, useNativeDriver: nativeDriver }));
		loop.start();
		return () => loop.stop();
	}, [busy, pulse]);
	return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
		{busy && <Animated.View style={{ position: "absolute", width: size, height: size, borderRadius: size, backgroundColor: color, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }] }} />}
		<View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />
	</View>;
}

export function Banner({ message, onDismiss, dismissLabel }: { message: string; onDismiss?: () => void; dismissLabel?: string }) {
	const theme = useTheme();
	return <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
		<Icon name="alert-circle" size={16} color={theme.danger} />
		<Text style={{ flex: 1, color: theme.danger, fontSize: 14, lineHeight: 19, fontWeight: "500" }}>{message}</Text>
		{onDismiss && <Pressable accessibilityRole="button" accessibilityLabel={dismissLabel} hitSlop={10} onPress={onDismiss}><Icon name="x" size={16} color={theme.danger} /></Pressable>}
	</View>;
}

export function Header({ title, subtitle, onBack, backLabel, children }: { title: ReactNode; subtitle?: ReactNode; onBack?: () => void; backLabel?: string; children?: ReactNode }) {
	const theme = useTheme();
	return <View style={styles.header}>
		<View style={styles.headerSide}>{onBack && <IconButton name="chevron-left" size={26} label={backLabel ?? "Back"} onPress={onBack} />}</View>
		<View style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
			{typeof title === "string" ? <Text numberOfLines={1} style={{ color: theme.strong, fontSize: 17, fontWeight: "700" }}>{title}</Text> : title}
			{subtitle}
		</View>
		<View style={[styles.headerSide, { justifyContent: "flex-end" }]}>{children}</View>
	</View>;
}

export const styles = StyleSheet.create({
	page: { flex: 1 },
	row: { flexDirection: "row", alignItems: "center", gap: 10 },
	button: { minHeight: 50, borderRadius: 16, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
	buttonSmall: { minHeight: 40, borderRadius: 12, paddingHorizontal: 14 },
	iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
	field: { minHeight: 50, borderRadius: 14, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
	fieldInput: { flex: 1, minHeight: 50, paddingVertical: 13, fontSize: 16 },
	group: { borderRadius: 20, overflow: "hidden" },
	groupRow: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
	banner: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
	header: { minHeight: 52, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4 },
	headerSide: { width: 88, flexDirection: "row", alignItems: "center" },
});
