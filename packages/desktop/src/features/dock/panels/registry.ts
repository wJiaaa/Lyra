/**
 * Which panels the side panel can show.
 *
 * The list was a literal inside the component and a matching `if` chain further down, which meant
 * adding a panel touched both and nothing else could add one at all. Here each panel is a record —
 * label, icon, shortcut, when it is unavailable, and what to render — so the component only has to
 * loop, and a plugin can contribute one by registering it.
 *
 * `availability` is a predicate over the app state rather than a boolean, because whether a panel
 * can open changes while the app runs: the terminal needs a workspace, the side chat needs a
 * conversation, and both arrive after the panel list is first built.
 */

import type { MessageKey } from "../../../i18n/messages/index.ts";
import { useMemo, useSyncExternalStore, type ComponentType } from "react";
import type { GitCompare } from "../../../ui/icons/index.ts";
import type { PaneKind } from "../tree.ts";
import type { PanelKind } from "../sideStore.ts";
import { basePanelKind } from "../../../lib/panel-instance.ts";

interface PanelAvailability {
	/** Inside one of the user's projects. The files and the repository mean something. */
	workspace: boolean;
	/**
	 * Somewhere to run at all, project or not.
	 *
	 * A project-less conversation still has a working directory — a scratch folder — which is
	 * enough for a shell but not enough for a file tree or a git panel: there is nothing in it and
	 * it is not a repository. Two questions, because two different sets of panels turn on them.
	 */
	cwd: boolean;
	session: boolean;
	/** 这场对话交过计划（`currentPlan`），或者正有一份等着审批。 */
	plan: boolean;
}

export interface PanelDefinition {
	kind: PanelKind;
	/** Looked up when the panel is drawn — see `translate`. */
	label: MessageKey;
	icon: typeof GitCompare;
	shortcut: string;
	/**
	 * Offer this panel in the + menu. Absent is listed.
	 *
	 * A pane can still be opened in code when this is false — the turn's file
	 * review is one: it belongs on a card click, not in a list of places you
	 * keep around.
	 */
	listed?: boolean;
	/**
	 * Drop this pane when a layout is saved or restored.
	 *
	 * For a viewing surface tied to the turn on screen, not a column you
	 * arranged. Leaving it in storage would reopen an empty review after
	 * a restart or a session switch.
	 */
	ephemeral?: boolean;
	/** Why it cannot be opened right now, given the current state. */
	unavailable?(state: PanelAvailability): MessageKey | undefined;
	/**
	 * Whether this panel survives being moved into a window of its own.
	 *
	 * A panel window is a second renderer. Anything the panel keeps in this one — a store, a
	 * `<webview>`, a subscription — does not travel with it, and the machinery that moves it has no
	 * way to know that. So the panel says.
	 *
	 * - `"self"` (the default): its state comes from the main process or from disk, and the new
	 *   window fetches it the same way this one did.
	 * - `"handoff"`: it carries something this renderer owns, and there is explicit code to move it.
	 *   The open file is the one — see `file-panel-handoff.ts`, and the `fileState` argument to
	 *   `windows:openPanel`.
	 * - `"none"`: it cannot go. The browser is the one: a `<webview>` belongs to the document that
	 *   created it, so "the same page" in another window is a fresh navigation — scroll, forms and
	 *   anything the page was holding are gone. Offering the button and then losing their work is
	 *   worse than not offering it.
	 *
	 * Absent means `"self"`, which is true of most panels and wrong silently for the rest. A new
	 * panel that needs one of the other two has to say so; `popOutPanel` refuses `"none"`.
	 */
	detach?: "self" | "handoff" | "none";
	render: ComponentType;
	/**
	 * Drawn in the pane header in place of the title.
	 *
	 * For a panel whose header is a control rather than a label — the open file's name and its menu.
	 * Everything else gets the title, which is what a header is for. Not for a strip of tabs: a panel
	 * that can hold several of something opens each as a tab of the dock instead, see `panel-instance.ts`.
	 */
	header?: ComponentType;
	/**
	 * 顶上那个标签写什么，代替注册的名字。能开好几个的面板用它把几个标签分开——侧边聊天写第一句话，
	 * 终端写 shell 的名字。拿不到就画 `fallback`。
	 */
	tabTitle?: ComponentType<{ scope: string; kind: PaneKind; fallback: string }>;
	/**
	 * 这一格被关掉时，放掉它自己的东西：侧边聊天的对话、终端的 shell、文件面板打开的文件、浏览器的网页。
	 *
	 * 右栏的每个标签就是一个浏览器标签页——关了就是没了，重开是新的。没有「最早那一格关掉只算收起」：
	 * 那样每种面板各留一份关不掉的东西，重开时又冒出来。凡是关的入口——标签上的 ✕、「⋮」菜单、
	 * 人关掉弹出去的那个窗口——都汇到 `closeNow` 和 `watchPanelWindows`，在那里调这一个。
	 *
	 * 不丢东西的是另外几件事：切标签、收起右栏、弹出与收回窗口、换会话。它们不走这里。设置一类的偏好
	 * （Git 的树形视图、终端的尺寸）不属于哪一格，也不在这里收。`kind` 是这一格的 kind，
	 * 能开好几个的面板据此认出是哪一个，见 `lib/panel-instance.ts`。
	 */
	onClose?: (scope: string, kind: PaneKind) => void;
	/**
	 * 关之前要不要先问一句。`false` 就不关。
	 *
	 * 只给「关了会丢掉正在进行的东西」的面板用——终端里跑着的程序。只在 `closePane` 里问：那是人点
	 * ✕ 和「⋮」菜单走的路；关掉弹出去的窗口由系统决定，问不了。
	 */
	confirmClose?: (scope: string, kind: PaneKind) => Promise<boolean>;
	/**
	 * 再开一个这种面板由它自己来，代替往树上放一格。
	 *
	 * 浏览器是这样的：一个标签就是一个网页（`browser:<网页 id>`），得先由主进程开出网页、有了 id，
	 * 标签才跟着出现（`useBrowserWorkspace` 里的 `reveal`）。工具栏按钮、快捷键、「+」和「⋮」菜单
	 * 都经 `showScopedPanel`，在那里先问这一个。
	 */
	create?: (scope: string) => void;
	/**
	 * 不在这一屏的标签条上、也要一直挂着的格子。
	 *
	 * 浏览器的网页是这样的：agent 在后台开的、驱动着的页面要有个文档可活，而 `<webview>` 挪一下就是
	 * 重载。所以一页从开出来起就待在自己那一格里，藏着；人点「打开」时把同一格放上标签条，原地亮出来，
	 * 见 `DockView` 的 `order`。`get` 只读状态，变了由 `subscribe` 通知——见 `useResidentPanes`。
	 */
	residents?: { subscribe: (listener: () => void) => () => void; get: (scope: string) => readonly PaneKind[] };
	/**
	 * Drawn in the header's controls, left of full screen and close.
	 *
	 * For what you do to whatever the panel is showing, as opposed to what you do to the pane. The
	 * file panel puts its wrap/format/open-in marks here; they used to be a labelled toolbar across
	 * the top of the file, which cost a line of the file on every file for four controls that never
	 * change. The conversation's own panel menu arrives by a different route — it belongs to the
	 * window rather than to a panel.
	 */
	actions?: ComponentType;
}

const registered: PanelDefinition[][] = [];

export function registerPanels(panels: PanelDefinition[]): () => void {
	registered.push(panels);
	return () => {
		const at = registered.indexOf(panels);
		if (at >= 0) registered.splice(at, 1);
	};
}

/**
 * Every panel, in registration order, later registrations replacing earlier ones by kind.
 *
 * Same rule as the tool registry: a plugin that wants its own Git panel registers under `review`
 * and displaces the built-in, rather than having to prevent it from loading.
 */
export function allPanels(): PanelDefinition[] {
	const byKind = new Map<PanelKind, PanelDefinition>();
	for (const set of registered) for (const panel of set) byKind.set(panel.kind, panel);
	return [...byKind.values()];
}

/**
 * Whether this kind may be moved into a window of its own — see `detach` on the definition.
 *
 * Unregistered kinds answer `"self"`: `conversation` is not a panel and never reaches this, and a
 * kind the registry has not heard of has nothing of its own to lose.
 */
export function detachOf(kind: PaneKind): "self" | "handoff" | "none" {
	return panelOf(kind)?.detach ?? "self";
}

function subscribeResidents(listener: () => void): () => void {
	const stops = allPanels().flatMap((panel) => (panel.residents ? [panel.residents.subscribe(listener)] : []));
	return () => {
		for (const stop of stops) stop();
	};
}

/**
 * 这一屏一直挂着的格子，见 `PanelDefinition.residents`。
 *
 * 拼成一个字符串当快照：值没变就是同一个快照，状态里无关的变动不让这一屏重画。kind 里没有空格。
 */
export function useResidentPanes(scope: string): PaneKind[] {
	const key = useSyncExternalStore(subscribeResidents, () =>
		allPanels()
			.flatMap((panel) => panel.residents?.get(scope) ?? [])
			.join(" "),
	);
	return useMemo(() => (key ? (key.split(" ") as PaneKind[]) : []), [key]);
}

/** 这一格用的是哪个注册项。后开的那几格用的是它们种类的那一个，见 `panel-instance.ts`。 */
export function panelOf(kind: PaneKind): PanelDefinition | undefined {
	const base = basePanelKind(kind);
	return allPanels().find((panel) => panel.kind === base);
}
