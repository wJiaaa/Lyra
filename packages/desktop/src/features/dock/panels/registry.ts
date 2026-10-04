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
import type { ComponentType } from "react";
import type { GitCompare } from "lucide-react";
import type { DropSide, PaneKind } from "../tree.ts";
import type { PanelKind } from "../sideStore.ts";
import { basePanelKind } from "../../../lib/panel-instance.ts";
import { onPhone } from "../../../services/index.ts";

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
	/**
	 * Expose this panel in the phone renderer. Absent stays desktop-only.
	 *
	 * A flag rather than a check against the methods the panel calls, because a panel calls many
	 * and what matters is whether it is any use at all: a terminal with no shell, a Git panel that
	 * cannot run git, a browser tab on the wrong machine. The ones marked are the conversation's
	 * own — its files to read, its sub-agents, side chat, tasks, trajectory — and every method they
	 * need is marked `remote` in the contract.
	 */
	mobile?: boolean;
	/** Why it cannot be opened right now, given the current state. */
	unavailable?(state: PanelAvailability): MessageKey | undefined;
	/**
	 * A panel this one belongs beside, and which side of it.
	 *
	 * Two panels are a *pair* when neither is much use alone: a file tree with nothing open is a
	 * list, and an open file without the tree is one file with no way to reach the next. The dock
	 * has no other notion of related panes — everything else is independent, and arranging it is
	 * the user's business.
	 *
	 * Declaring it buys two things. Opening this panel puts it beside its partner rather than
	 * wherever new panels go, so a tree and a file land as a tree *and* a file. And making either
	 * one full screen brings the other, because "show me this properly" means the pair when the
	 * pair is what you are working in.
	 *
	 * Only honoured while the two are actually adjacent. Drag them apart and they are two ordinary
	 * panes again — a full screen that quietly swallowed half the window because of a relationship
	 * declared in a file nobody has read would be worse than not having the feature at all.
	 */
	companion?: {
		kind: PanelKind;
		side: DropSide;
		/**
		 * How much of the pair this panel takes when it opens beside its partner.
		 *
		 * Halves are the wrong default for a browser: a file tree needs enough width for a name and
		 * an editor needs the rest. Absent, the two split evenly like any other new pane.
		 */
		share?: number;
	};
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
	 * 人关掉后开的那一格（`<种类>:<id>`）时，它手上的东西怎么收。
	 *
	 * 最早那一格关掉只是收起，工具栏和快捷键还能原样叫回来；后开的那几格关掉就再没有入口了，留着
	 * 只是一个够不着的对话、一个没人看的 shell。弹出窗口也会把面板从树里拿走，那不算关，不走这里。
	 */
	closeInstance?: (scope: string, instance: string) => void;
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
	const panels = [...byKind.values()];
	// Filtered here, where every consumer — the + menu, the shortcuts, the dock — already looks.
	return onPhone() ? panels.filter((panel) => panel.mobile) : panels;
}

/**
 * Whether this kind may be moved into a window of its own — see `detach` on the definition.
 *
 * Unregistered kinds answer `"self"`: `conversation` is not a panel and never reaches this, and a
 * kind the registry has not heard of has nothing of its own to lose.
 */
export function detachOf(kind: PaneKind): "self" | "handoff" | "none" {
	// A phone has no second window to move anything into.
	if (onPhone()) return "none";
	return panelOf(kind)?.detach ?? "self";
}

/** 这一格用的是哪个注册项。后开的那几格用的是它们种类的那一个，见 `panel-instance.ts`。 */
export function panelOf(kind: PaneKind): PanelDefinition | undefined {
	const base = basePanelKind(kind);
	return allPanels().find((panel) => panel.kind === base);
}
