import type { UiLocale } from "@lyra/core";

export type NativeLocale = Exclude<UiLocale, "system">;

const zhCN = {
	"tray.show": "打开 Lyra",
	"tray.hide": "隐藏 Lyra",
	"tray.newChat": "新对话",
	"tray.recent": "最近会话",
	"tray.noChats": "还没有会话",
	"tray.pullRequests": "拉取请求",
	"tray.scheduled": "已安排",
	"tray.settings": "设置…",
	"tray.updates": "检查更新…",
	"tray.launchAtLogin": "开机时启动",
	"tray.quit": "退出 Lyra",
	"dialog.projectDirectory": "选择项目目录",
	"dialog.screenshotDirectory": "选择截图保存位置",
	"shortcut.taken": "截图全局快捷键 {shortcut} 没能注册，可能已被其他应用占用（比如微信的截图键）。可以在 设置 → 屏幕截图 里换一个。",
	"shortcut.invalid": "截图全局快捷键 {shortcut} 无法识别，没有注册。可以在 设置 → 屏幕截图 里重新录一个。",
	"terminal.unavailable": "终端无法启动：原生组件 node-pty 没能加载。Lyra 的其他功能不受影响。",
	"update.appImageNotWritable": "新版本没法写进 AppImage 所在的文件夹（{reason}）。把 AppImage 放到自己有写权限的位置，或者到发布页手动下载。",
	"update.adminDismissed": "没有获得管理员授权，更新没有安装。重试时会再次询问密码。",
	"update.installFailed": "安装没有完成：{reason}",
} as const;

type NativeMessageKey = keyof typeof zhCN;
type NativeCatalog = Record<NativeMessageKey, string>;

const catalogs: Record<NativeLocale, NativeCatalog> = {
	"zh-CN": zhCN,
	en: {
		"tray.show": "Open Lyra", "tray.hide": "Hide Lyra", "tray.newChat": "New chat", "tray.recent": "Recent chats", "tray.noChats": "No chats yet", "tray.pullRequests": "Pull requests", "tray.scheduled": "Scheduled", "tray.settings": "Settings…", "tray.updates": "Check for updates…", "tray.launchAtLogin": "Launch at login", "tray.quit": "Quit Lyra", "dialog.projectDirectory": "Choose project folder", "dialog.screenshotDirectory": "Choose screenshot folder",
		"shortcut.taken": "The global shortcut {shortcut} could not be registered — another app is probably using it (WeChat's screenshot key, for one). Pick another in Settings → Screenshots.",
		"shortcut.invalid": "The global shortcut {shortcut} is not a key combination this system recognises, so it was not registered. Record it again in Settings → Screenshots.",
		"terminal.unavailable": "The terminal cannot start: its native component, node-pty, failed to load. The rest of Lyra is unaffected.",
		"update.appImageNotWritable": "The new version could not be written next to the AppImage ({reason}). Move the AppImage somewhere you can write to, or download it from the release page.",
		"update.adminDismissed": "Administrator permission was not given, so the update was not installed. Retrying will ask again.",
		"update.installFailed": "The installation did not finish: {reason}",
	},
};

export function resolveNativeLocale(locale: UiLocale, systemLocale: string): NativeLocale {
	if (locale !== "system") return locale;
	const normalized = systemLocale.trim().replaceAll("_", "-").toLowerCase();
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
	return "en";
}

export function nativeTranslator(locale: UiLocale, systemLocale: string): (key: NativeMessageKey) => string {
	const catalog = catalogs[resolveNativeLocale(locale, systemLocale)];
	return (key) => catalog[key];
}
