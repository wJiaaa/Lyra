import { nativeTranslator, type NativeLocale } from "./i18n.ts";

/**
 * What the status bar menu offers, as data.
 *
 * Separated from `tray.ts` so the menu can be read — and tested — without Electron. What belongs
 * in it is a product question with a short answer: the things worth doing when the window is not
 * in front of you. Everything here is reachable in one press from a cold app.
 *
 * The same list on every platform, deliberately. Where the platforms differ is how the menu is
 * *raised* — macOS attaches it to the right button and keeps the left one toggling the window,
 * Windows and Linux let the system raise it — and that is a convention each system owns. What is
 * in it is ours, and a menu that offered different things depending on which machine you sat at
 * would be two products.
 */

/**
 * What a menu item asks the renderer to do; see `src/tray-commands.ts`.
 *
 * Strings rather than a richer channel, because the whole contract between a menu that knows
 * nothing about views and a window that knows nothing about menus is the name. `open-session`
 * carries its subject in the name for the same reason — one channel, one shape.
 */
export type TrayCommand =
	| "new-session"
	| "pull-requests"
	| "scheduled"
	| "settings"
	| "updates"
	| `open-session:${string}`;

export type TrayAction =
	| { kind: "toggle-window" }
	| { kind: "command"; command: TrayCommand }
	/** Open one conversation by id, which is the only action carrying a subject. */
	| { kind: "open-session"; id: string }
	| { kind: "toggle-login" }
	| { kind: "quit" };

export type TrayItem =
	| { type: "separator" }
	| { type: "item"; label: string; action: TrayAction; checked?: boolean; enabled?: boolean }
	| { type: "submenu"; label: string; items: TrayItem[] };

export interface TrayState {
	/** Whether there is a window on screen right now, which decides what the first item says. */
	windowVisible: boolean;
	/** The most recent conversations, newest first. Already filtered and sorted by the caller. */
	recent: { id: string; title: string }[];
	launchAtLogin: boolean;
	/** Already-resolved locale for the native menu. */
	locale?: NativeLocale;
}

/**
 * How many conversations the submenu lists.
 *
 * Five is the number that fits without scrolling in every system's own menu at a default font
 * size, and this is a shortcut rather than the session list — anything older is one click further
 * on, in the window that exists to show them all.
 */
export const RECENT_LIMIT = 5;

/**
 * Menu labels are one line, and a conversation's title is a sentence someone typed. An untitled
 * conversation uses the menu's own locale rather than borrowing the renderer's language.
 *
 * Cut rather than wrapped, because a system menu does not wrap: an untrimmed title stretches the
 * menu to the width of the longest thing anyone has ever asked, which on this app is a paragraph.
 */
export function trayTitle(title: string | undefined, limit = 28, untitled = "新对话"): string {
	const text = (title ?? "").trim();
	if (!text) return untitled;
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function trayMenu(state: TrayState): TrayItem[] {
	const recent = state.recent.slice(0, RECENT_LIMIT);
	const t = nativeTranslator(state.locale ?? "zh-CN", "en");

	return [
		{
			type: "item",
			// Names what pressing it will do, not what is currently true.
			label: state.windowVisible ? t("tray.hide") : t("tray.show"),
			action: { kind: "toggle-window" },
		},
		{ type: "separator" },
		{ type: "item", label: t("tray.newChat"), action: { kind: "command", command: "new-session" } },
		{
			type: "submenu",
			label: t("tray.recent"),
			items:
				recent.length > 0
					? recent.map((session) => ({
							type: "item" as const,
							label: trayTitle(session.title, 28, t("tray.newChat")),
							action: { kind: "open-session" as const, id: session.id },
						}))
					: // A disabled row rather than an empty menu, which reads as a menu that failed to load.
						[{ type: "item" as const, label: t("tray.noChats"), action: { kind: "toggle-window" as const }, enabled: false }],
		},
		{ type: "separator" },
		{ type: "item", label: t("tray.pullRequests"), action: { kind: "command", command: "pull-requests" } },
		{ type: "item", label: t("tray.scheduled"), action: { kind: "command", command: "scheduled" } },
		{ type: "separator" },
		{ type: "item", label: t("tray.settings"), action: { kind: "command", command: "settings" } },
		{ type: "item", label: t("tray.updates"), action: { kind: "command", command: "updates" } },
		{
			type: "item",
			label: t("tray.launchAtLogin"),
			action: { kind: "toggle-login" },
			checked: state.launchAtLogin,
		},
		{ type: "separator" },
		{ type: "item", label: t("tray.quit"), action: { kind: "quit" } },
	];
}
