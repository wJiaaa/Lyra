import { useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import { setStringAsync } from "expo-clipboard";
import { Icon, useTheme } from "./ui.tsx";

/** 复制以后那颗按钮变成一个勾，停一秒半：手机上没有悬停提示，不给反馈就不知道按到了没有。 */
export function useCopy(): [boolean, (text: string) => void] {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
	return [copied, (text) => {
		void setStringAsync(text).then(() => {
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 1500);
		}).catch(() => undefined);
	}];
}

export function CopyButton({ text, label, copiedLabel, caption }: { text: string; label: string; copiedLabel: string; caption?: boolean }) {
	const theme = useTheme();
	const [copied, copy] = useCopy();
	return <Pressable accessibilityRole="button" accessibilityLabel={copied ? copiedLabel : label} onPress={() => copy(text)} hitSlop={8} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: 28, paddingHorizontal: 6, borderRadius: 8, opacity: pressed ? 0.55 : 1 })}>
		<Icon name={copied ? "check" : "copy"} size={13} color={copied ? theme.success : theme.muted} />
		{caption && <Text style={{ color: copied ? theme.success : theme.muted, fontSize: 12 }}>{copied ? copiedLabel : label}</Text>}
	</Pressable>;
}
