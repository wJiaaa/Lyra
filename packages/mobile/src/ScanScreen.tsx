import { useRef, useState } from "react";
import { View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button, Header, Icon, Txt, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/** 取景框只画四个角：整圈边框会把画面切成一个小窗，四个角只说「对准这里」。 */
function Corners({ color }: { color: string }) {
	const arm = 34;
	const edge = { position: "absolute", width: arm, height: arm, borderColor: color } as const;
	return <View pointerEvents="none" style={{ position: "absolute", top: "14%", left: "14%", right: "14%", bottom: "14%" }}>
		<View style={[edge, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 }]} />
		<View style={[edge, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 }]} />
		<View style={[edge, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 }]} />
		<View style={[edge, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 }]} />
	</View>;
}

export function ScanScreen({ submit, close, busy, t }: { submit(code: string): void; close(): void; busy: boolean; t: T }) {
	const theme = useTheme();
	const [permission, requestPermission] = useCameraPermissions();
	const [invalid, setInvalid] = useState(false);
	// 摄像头每秒会把同一个码报好几次；处理中的那一次没结束前，后面的都丢掉。
	const locked = useRef(false);
	function scanned(data: string) {
		if (locked.current || busy) return;
		locked.current = true;
		if (data.startsWith("plume://pair")) { setInvalid(false); submit(data); }
		else setInvalid(true);
		setTimeout(() => { locked.current = false; }, 1200);
	}
	return <View style={{ flex: 1 }}>
		<Header title={t("scanTitle")} onBack={close} backLabel={t("cancel")} />
		<View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 12, gap: 18 }}>
			{permission?.granted ? <View style={{ width: "100%", maxWidth: 420, aspectRatio: 1, alignSelf: "center", borderRadius: 24, overflow: "hidden", backgroundColor: theme.grouped }}>
				<CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => scanned(data)} />
				<Corners color={invalid ? theme.danger : theme.accent} />
			</View> : <View style={{ borderRadius: 24, backgroundColor: theme.grouped, padding: 24, gap: 12, alignItems: "flex-start" }}>
				<View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: theme.card, alignItems: "center", justifyContent: "center" }}><Icon name="camera" size={20} color={theme.accent} /></View>
				<Txt kind="heading" tone="strong">{t("cameraTitle")}</Txt>
				<Txt kind="sub" tone="muted">{t("cameraBody")}</Txt>
				<View style={{ alignSelf: "stretch", marginTop: 4 }}><Button label={t("camera")} onPress={() => void requestPermission()} /></View>
			</View>}
			<View style={{ alignItems: "center", gap: 6 }}>
				<Txt kind="sub" tone={invalid ? "danger" : "muted"} style={{ textAlign: "center" }}>{busy ? t("pairing") : invalid ? t("invalidCode") : t("scanHint")}</Txt>
			</View>
		</View>
	</View>;
}
