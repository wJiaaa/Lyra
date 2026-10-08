import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton, nativeDriver, useTheme } from "./ui.tsx";

/**
 * 从底部升起的面板。
 *
 * 不用 Modal 自带的 slide：它把遮罩连同面板一起推上来，暗下去的那层看着像一块灰板在移动。
 * 遮罩淡入、面板滑入分开做，关闭时先播完退场再卸载。内容要在选完后自己收起时，用函数形式
 * 的 children 拿到 `dismiss`，而不是直接调 `close`——后者会跳过退场。
 */
export function Sheet({ title, close, children, footer, closeLabel, tall = false }: { title: string; close(): void; children: ReactNode | ((dismiss: () => void) => ReactNode); footer?: ReactNode | ((dismiss: () => void) => ReactNode); closeLabel: string; tall?: boolean }) {
	const theme = useTheme();
	const insets = useSafeAreaInsets();
	const { height } = useWindowDimensions();
	const progress = useRef(new Animated.Value(0)).current;
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		Animated.timing(progress, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver }).start();
	}, [progress]);
	function dismiss() {
		if (leaving) return;
		setLeaving(true);
		Animated.timing(progress, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: nativeDriver }).start(() => close());
	}
	return <Modal transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Animated.View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.backdrop, opacity: progress }}>
				<Pressable accessibilityRole="button" accessibilityLabel={closeLabel} onPress={dismiss} style={{ flex: 1 }} />
			</Animated.View>
			<View pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end" }}>
				<Animated.View accessibilityViewIsModal style={{ backgroundColor: theme.elevated, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: height * (tall ? 0.92 : 0.8), paddingBottom: Math.max(insets.bottom, 16), width: "100%", maxWidth: 720, alignSelf: "center", transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height * 0.5, 0] }) }] }}>
					<View style={{ alignItems: "center", paddingTop: 7 }}><View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.line }} /></View>
					<View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, paddingTop: 6, paddingBottom: 6 }}>
						<Text numberOfLines={1} style={{ flex: 1, color: theme.strong, fontSize: 17, fontWeight: "700" }}>{title}</Text>
						<IconButton name="x" label={closeLabel} onPress={dismiss} filled size={18} />
					</View>
					{typeof children === "function" ? children(dismiss) : children}
					{footer && <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>{typeof footer === "function" ? footer(dismiss) : footer}</View>}
				</Animated.View>
			</View>
		</KeyboardAvoidingView>
	</Modal>;
}
