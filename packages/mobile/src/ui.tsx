import { createContext, useContext, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";

/*
 * 色板不再照搬桌面 tokens.css 的面板灰。桌面是多栏、靠面板之间的灰阶分区；手机是单列，整页一张底，
 * 层次只靠「浮起来的东西」和发丝线。照 t3code / happy / paseo 的手机端：底色压得更深（暗 #0a0a0a、
 * 亮 #fcfcfc），列表和助手回复直接落在底上，只有用户气泡、代码和浮起的控件有面。强调色仍与桌面同一个蓝。
 */
export const dark = {
	bg: "#0a0a0a", grouped: "#141415", card: "#252527", elevated: "#1c1c1e", bubble: "#212124", line: "#27272a", lineSoft: "#1c1c1e",
	ink: "#e4e4e7", strong: "#fafafa", muted: "#8e8e93", faint: "#5b5b60",
	accent: "#339cff", accentSoft: "rgba(51,156,255,0.15)", success: "#3ecf8e", successSoft: "rgba(62,207,142,0.13)", warning: "#f0a83a", warningSoft: "rgba(240,168,58,0.14)",
	danger: "#f2555a", dangerSoft: "rgba(242,85,90,0.13)", backdrop: "rgba(0,0,0,0.55)", onAccent: "#ffffff",
	/** 浮起控件的投影：暗底上要重一点才看得出浮着。 */
	shadow: "0px 8px 28px rgba(0,0,0,0.45)",
};
export const light: typeof dark = {
	bg: "#fcfcfc", grouped: "#f4f4f5", card: "#efeff1", elevated: "#ffffff", bubble: "#efeff1", line: "#e4e4e7", lineSoft: "#efeff1",
	ink: "#27272a", strong: "#111113", muted: "#6f6f79", faint: "#a1a1aa",
	accent: "#087ee0", accentSoft: "rgba(8,126,224,0.10)", success: "#158357", successSoft: "rgba(21,131,87,0.10)", warning: "#b26b00", warningSoft: "rgba(178,107,0,0.10)",
	danger: "#d13740", dangerSoft: "rgba(209,55,64,0.09)", backdrop: "rgba(0,0,0,0.22)", onAccent: "#ffffff",
	shadow: "0px 6px 24px rgba(0,0,0,0.08)",
};
export type Palette = typeof dark;

export const Theme = createContext(dark);
export const useTheme = () => useContext(Theme);
export type IconName = ComponentProps<typeof Feather>["name"];
export const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
// Web 上 Animated 没有原生驱动，开着会每次打一条警告。
export const nativeDriver = Platform.OS !== "web";

/** 浮在内容上的东西（输入框、授权卡、状态胶囊、底部面板）共用一套：浮面底色、一圈细边、一层软投影。 */
export function floating(theme: Palette): ViewStyle {
	return { backgroundColor: theme.elevated, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line, boxShadow: theme.shadow };
}

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
	eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
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
		<Text style={{ color, fontSize: small ? 15 : 16, fontWeight: "600" }}>{label}</Text>
	</Pressable>;
}

/** `filled` 是标题栏上那种独立的圆钮：浮面底加一圈细边，像 happy 顶栏两侧的按钮，而不是一块灰斑。 */
export function IconButton({ name, label, onPress, disabled = false, filled = false, color, size = 20 }: { name: IconName; label: string; onPress(): void; disabled?: boolean; filled?: boolean; color?: string; size?: number }) {
	const theme = useTheme();
	return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.iconButton, filled && { backgroundColor: theme.grouped, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line }, { opacity: disabled ? 0.35 : pressed ? 0.55 : 1 }]}>
		<Icon name={name} color={color} size={size} />
	</Pressable>;
}

/**
 * `compact` 是列表顶上的搜索框那一档：38 高，和下面一排筛选连在一起读，不和表单字段一样厚。
 * `trailing` 是贴在框内右侧的控件（比如改名的确认钮），右内衬随之收窄，让它和框的圆角同心。
 */
export function Field({ icon, style, compact = false, trailing, ...props }: TextInputProps & { icon?: IconName; compact?: boolean; trailing?: ReactNode }) {
	const theme = useTheme();
	return <View style={[styles.field, compact && styles.fieldCompact, { backgroundColor: theme.card }, props.multiline && { alignItems: "flex-start" }, trailing ? { paddingRight: 8 } : null]}>
		{icon && <Icon name={icon} size={compact ? 16 : 17} color={theme.faint} />}
		<TextInput placeholderTextColor={theme.faint} selectionColor={theme.accent} {...props} style={[styles.fieldInput, compact && styles.fieldInputCompact, { color: theme.ink }, style]} />
		{trailing}
	</View>;
}

/** 小号的分组名。字段标签和分组标题都用它，让一页里只有一种「这是标签」的写法。 */
export function Eyebrow({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	return <Txt kind="eyebrow" tone="muted" style={[{ paddingHorizontal: 4 }, style]}>{children}</Txt>;
}

export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const theme = useTheme();
	return <View style={[styles.group, { backgroundColor: theme.grouped }, style]}>{children}</View>;
}

/**
 * 分组列表的一行。给了 `tint` 时图标放进一块有色的小方块（iOS 设置页的写法）：一眼先认颜色，
 * 再读字；没给时就是一枚淡色的线条图标。分隔线从文字起始处开始画，不横穿图标那一列。
 */
export function GroupRow({ icon, tint, label, value, detail, onPress, danger = false, chevron = !!onPress, first = false, disabled = false, trailing }: { icon?: IconName; tint?: string; label: string; value?: string; detail?: string; onPress?: () => void; danger?: boolean; chevron?: boolean; first?: boolean; disabled?: boolean; trailing?: ReactNode }) {
	const theme = useTheme();
	const ink = danger ? theme.danger : theme.ink;
	const inset = icon ? (tint ? 56 : 46) : 16;
	const body = <>
		{icon && (tint
			? <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: tint, alignItems: "center", justifyContent: "center" }}><Icon name={icon} size={16} color="#ffffff" /></View>
			: <Icon name={icon} size={18} color={danger ? theme.danger : theme.muted} />)}
		<View style={{ flex: 1, minWidth: 0 }}>
			<Text numberOfLines={1} style={{ color: ink, fontSize: 16, lineHeight: 22 }}>{label}</Text>
			{detail && <Text numberOfLines={2} style={{ color: theme.muted, fontSize: 13, lineHeight: 18, marginTop: 1 }}>{detail}</Text>}
		</View>
		{value && <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 15, maxWidth: 180 }}>{value}</Text>}
		{trailing}
		{chevron && <Icon name="chevron-right" size={17} color={theme.faint} />}
	</>;
	const frame = [styles.groupRow, { opacity: disabled ? 0.4 : 1 }];
	const line = !first && <View style={{ position: "absolute", top: 0, right: 0, left: inset, height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />;
	if (!onPress) return <View style={frame}>{line}{body}</View>;
	return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [...frame, pressed && { backgroundColor: theme.card }]}>{line}{body}</Pressable>;
}

// 项目标记的几种底色：同一个项目在列表、新建面板里永远是同一个颜色，扫一眼就知道是哪个项目。
const MARKS = ["#339cff", "#3ecf8e", "#f0a83a", "#b48cf2", "#f2555a", "#2bc4c4", "#e879a8", "#8f9bb3"];
/** 项目名首字的小方块，代替 paseo / t3code 里的项目图标；没有项目的会话给一枚空心方块。 */
export function ProjectMark({ name, size = 18 }: { name?: string; size?: number }) {
	const theme = useTheme();
	if (!name) return <View style={{ width: size, height: size, borderRadius: size * 0.28, borderWidth: 1, borderColor: theme.line, borderStyle: "dashed" }} />;
	const color = MARKS[[...name].reduce((sum, char) => sum + char.codePointAt(0)!, 0) % MARKS.length]!;
	return <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: `${color}2e`, alignItems: "center", justifyContent: "center" }}>
		<Text style={{ color, fontSize: size * 0.58, lineHeight: size, fontWeight: "700" }}>{[...name.trim()][0]?.toUpperCase()}</Text>
	</View>;
}

export type Status = "offline" | "connecting" | "connected" | "reconnecting";
/** 连上是绿点；正在连时点外有一圈慢慢散开的光，好让「还在努力」和「已经断了」看得出区别。`color` 覆盖默认的连接色，「进行中」用它画蓝点。 */
export function StatusDot({ status, size = 8, color: override }: { status: Status; size?: number; color?: string }) {
	const theme = useTheme();
	const color = override ?? (status === "connected" ? theme.success : status === "offline" ? theme.danger : theme.warning);
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

/** 一段字在 0.45 和 1 之间来回呼吸：正在跑的那一步、正在思考，用它说「还在动」，不另加转圈。 */
export function Breathing({ children, active = true }: { children: ReactNode; active?: boolean }) {
	const value = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		if (!active) { value.setValue(1); return; }
		const loop = Animated.loop(Animated.sequence([
			Animated.timing(value, { toValue: 0.45, duration: 700, useNativeDriver: nativeDriver }),
			Animated.timing(value, { toValue: 1, duration: 700, useNativeDriver: nativeDriver }),
		]));
		loop.start();
		return () => loop.stop();
	}, [active, value]);
	return <Animated.View style={{ opacity: value, flex: 1, minWidth: 0 }}>{children}</Animated.View>;
}

/**
 * 刚出现的东西从上方 6px 淡入：展开一轮过程、点开思考时，新长出来的几行是「落下来」的，而不是凭空跳出。
 * 只在挂载时播一次，`active` 为假时直接就位——列表虚拟化会在滚回来时重新挂载同一行，那时不该再播。
 */
export function Appear({ children, active = true }: { children: ReactNode; active?: boolean }) {
	const value = useRef(new Animated.Value(active ? 0 : 1)).current;
	useEffect(() => {
		if (active) Animated.timing(value, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver }).start();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 动画只属于挂载那一刻，active 之后的变化不该重播
	}, [value]);
	return <Animated.View style={{ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] }}>{children}</Animated.View>;
}

/** 展开 / 收起的箭头转过去，而不是换一枚图标：转的过程本身就在说「这里开了」。 */
export function Chevron({ open, size = 13, color }: { open: boolean; size?: number; color?: string }) {
	const theme = useTheme();
	const value = useRef(new Animated.Value(open ? 1 : 0)).current;
	useEffect(() => {
		Animated.timing(value, { toValue: open ? 1 : 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver }).start();
	}, [open, value]);
	return <Animated.View style={{ transform: [{ rotate: value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) }] }}>
		<Icon name="chevron-down" size={size} color={color ?? theme.faint} />
	</Animated.View>;
}

export function Banner({ message, onDismiss, dismissLabel }: { message: string; onDismiss?: () => void; dismissLabel?: string }) {
	const theme = useTheme();
	return <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
		<Icon name="alert-circle" size={16} color={theme.danger} />
		<Text style={{ flex: 1, color: theme.danger, fontSize: 14, lineHeight: 19, fontWeight: "500" }}>{message}</Text>
		{onDismiss && <Pressable accessibilityRole="button" accessibilityLabel={dismissLabel} hitSlop={10} onPress={onDismiss}><Icon name="x" size={16} color={theme.danger} /></Pressable>}
	</View>;
}

/** `divided`：下面的内容已经滚到标题栏底下了。停在顶部时不画线，滚走以后才需要一道边把两者分开。 */
export function Header({ title, subtitle, onBack, backLabel, divided = false, leading, children }: { title: ReactNode; subtitle?: ReactNode; onBack?: () => void; backLabel?: string; divided?: boolean; leading?: ReactNode; children?: ReactNode }) {
	const theme = useTheme();
	return <View style={[styles.header, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divided ? theme.line : "transparent" }]}>
		<View style={styles.headerSide}>{leading ?? (onBack && <IconButton name="chevron-left" size={22} label={backLabel ?? "Back"} onPress={onBack} filled />)}</View>
		<View style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
			{typeof title === "string" ? <Text numberOfLines={1} style={{ color: theme.strong, fontSize: 16, lineHeight: 21, fontWeight: "600" }}>{title}</Text> : title}
			{subtitle}
		</View>
		<View style={[styles.headerSide, { justifyContent: "flex-end" }]}>{children}</View>
	</View>;
}

export const styles = StyleSheet.create({
	page: { flex: 1 },
	row: { flexDirection: "row", alignItems: "center", gap: 10 },
	button: { minHeight: 50, borderRadius: 16, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
	buttonSmall: { minHeight: 42, borderRadius: 14, paddingHorizontal: 14 },
	iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
	field: { minHeight: 50, borderRadius: 14, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
	fieldInput: { flex: 1, minHeight: 50, paddingVertical: 13, fontSize: 16 },
	fieldCompact: { minHeight: 38, borderRadius: 12, paddingHorizontal: 12, gap: 8 },
	fieldInputCompact: { minHeight: 38, paddingVertical: 8, fontSize: 15 },
	group: { borderRadius: 14, overflow: "hidden" },
	groupRow: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
	banner: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
	header: { minHeight: 52, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 4 },
	headerSide: { width: 92, flexDirection: "row", alignItems: "center", gap: 8 },
});
