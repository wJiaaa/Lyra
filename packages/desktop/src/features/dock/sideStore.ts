/**
 * State for the side chats beside each session, and that session's task queue.
 *
 * A side chat is a session of its own (`SessionMeta.parentId`): its transcript lives in the app
 * store's `sessionCache` like any conversation on another screen, and the panel draws it with the
 * main `Conversation`. What is kept here is only what ties a panel to that session — which session
 * sits behind which panel (`sides`) — plus the bits of panel state no session owns.
 *
 * **按会话存，不是「当前那一份」。** 分屏之后屏上同时有不止一个会话，每一屏都能开侧边聊天；一个会话
 * 旁边又可以开好几个，按面板自己的 id 分（见 `panel-instance.ts`）。任务队列是主会话的，几个侧边
 * 聊天往同一条队里派活，所以按会话存在 `tasks` 里。
 */

import type { QueuedTask, SessionMeta } from "@plume/core";
import { create } from "zustand";

import { bridge } from "../../services/index.ts";
import type { PanelInstanceKind } from "../../lib/panel-instance.ts";
import type { DraftQuote } from "../../lib/quote.ts";

/**
 * What can occupy a pane. One of each at a time — two diffs of one worktree is not a thing.
 *
 * `chat` here is the *side* chat, a second conversation you can run beside the main one. The main
 * thread is `conversation`, which the dock adds to this set; the two names are close and the
 * things are not, which is worth the sentence. `files` is the tree and `file` is whichever one of
 * them is open — two panes, because they are two things you arrange separately.
 *
 * 侧边聊天、终端和文件是例外：一个会话可以开好几个，后开的是 `chat:<id>` / `terminal:<id>` / `file:<id>`，见 `panel-instance.ts`。
 */
export type PanelKind =
	| "files"
	| "file"
	| "chat"
	| PanelInstanceKind
	/** Work the main agent delegated — see `components/subagents/`. */
	| "subagents"
	| "terminal"
	| "review"
	/**
	 * This conversation turn's recorded file diffs.
	 *
	 * Not the worktree. Git's version review is `review`; the file pane is the
	 * current contents. This one is only what the latest turn wrote.
	 */
	| "delivery"
	| "browser"
	| "tasks"
	| "trajectory";

/** Just enough of a preview for the panel to load it; the card owns the full record. */
interface BrowserPreview {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
	/** Handed to the page with its address — the theme it wears in the panel. See `shared/preview.ts`. */
	fragment?: string;
}


interface SideState {
	/**
	 * `sides[会话][面板 id]`：这一格背后的侧边聊天会话。
	 *
	 * 会话到第一次提问（或者先挑了模型）时才建，所以开着却还没开口的那一格在这里没有条目。
	 */
	sides: Record<string, Record<string, SessionMeta>>;
	/** 主会话的任务队列，按会话存——几个侧边聊天派的活排在同一条队里。 */
	tasks: Record<string, QueuedTask[]>;
	/**
	 * 等着被放进某个侧边聊天输入框的东西，键是 `sideKey`；计数让同一句退回两次也算两次。
	 * `text` 进框里接着写（退回的任务），`quotes` 挂到框上方那枚引用上（对话里划下的一段）。
	 */
	draftSeeds: Record<string, { text: string; quotes: DraftQuote[]; nonce: number }>;

	/**
	 * A command the user asked to run, waiting for the terminal to pick it up.
	 *
	 * Handed over rather than executed here: the pty belongs to the terminal pane, which may not
	 * exist yet when the button is pressed. The pane clears this once it has written it, so the
	 * same command is never run twice.
	 */
	pendingCommand: string | null;
	/**
	 * The screen whose terminal runs `pendingCommand` — the key of the screen it was asked from — or
	 * null for the screen with focus.
	 *
	 * Every screen can have a terminal open, and each of them watches the one slot above. They used
	 * to settle it by the focus alone, and the keyboard presses 「在终端运行」 in a screen without
	 * giving it the focus: the terminal opened in that screen while the command ran in the shell of
	 * the conversation beside it, in the other project's directory.
	 */
	pendingScreen: string | null;
	/** `screen` names the screen asking; left out, the command is for whichever screen has focus. */
	runInTerminal(command: string, screen?: string | null): void;
	commandTaken(): void;
	/**
	 * What the browser tab is showing.
	 *
	 * A preview handed over from the transcript, a URL typed into the address bar, or nothing.
	 * Held here rather than inside the panel so "open this in the side panel" can be a single
	 * call from a card that knows nothing about how the panel is built.
	 *
	 * A preview can name the conversation whose browser it opens in — the one whose transcript it
	 * was opened from, which in a split need not be the one with focus. Unnamed, it is the live one.
	 */
	browserTarget: { kind: "preview"; preview: BrowserPreview; sessionId?: string | null } | { kind: "url"; url: string } | null;
	openPreview(preview: BrowserPreview, sessionId?: string | null): void;
	openUrl(url: string): void;

	/**
	 * Pull what this session already has: its task queue, and the side chats beside it.
	 * Safe to call for several sessions at once.
	 */
	attach(sessionId: string | null, force?: boolean): Promise<void>;
	/** 这一格背后的会话，没有就让主进程建一个。同一格并发叫只建一个。 */
	open(sessionId: string, sideId: string): Promise<SessionMeta>;
	/** 一个侧边聊天会话变了（`sessions:changed`）：记下最新的那份。 */
	noteSide(meta: SessionMeta): void;
	/** 一个侧边聊天会话没了。 */
	forgetSide(id: string): void;
	/** 关掉一格：会话连同记录一起删掉。 */
	close(sessionId: string | null, sideId: string): Promise<void>;
	cancelTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Take a finished row off the list. What it did, if anything, stays in the transcript. */
	dismissTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Put a stopped task back on the queue — interrupted by a pause, or failed. */
	resumeTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Hand text back to the composer — see the note on the implementation. */
	seedDraft(sessionId: string | null, sideId: string, text: string): void;
	/** 对话里划下的一段，交给那一格的输入框挂成引用。 */
	seedQuote(sessionId: string | null, sideId: string, quote: DraftQuote): void;
	clearDraftSeed(sessionId: string | null, sideId: string): void;
	setTasks(sessionId: string, tasks: QueuedTask[]): void;
}

export function sideKey(sessionId: string, sideId: string): string {
	return `${sessionId}\0${sideId}`;
}

/**
 * 没有任务的会话读出来的东西。
 *
 * 一个常量而不是每次新建一个：selector 直接把它交给组件，每次换一个新对象等于每次都「变了」，
 * React 会一直重画。
 */
const NO_TASKS: QueuedTask[] = [];

/** 这一格背后的会话；还没开口的是 null。 */
export function sideOf(state: Pick<SideState, "sides">, sessionId: string | null, sideId: string): SessionMeta | null {
	return (sessionId ? state.sides[sessionId]?.[sideId] : undefined) ?? null;
}

/** 这个会话是不是某一格侧边聊天，是的话挂在谁旁边。 */
export function sideParentOf(state: Pick<SideState, "sides">, id: string): string | null {
	for (const [parentId, sides] of Object.entries(state.sides)) {
		if (Object.values(sides).some((meta) => meta.id === id)) return parentId;
	}
	return null;
}

/** 这个会话主队列里的活。 */
export function sideTasksOf(state: Pick<SideState, "tasks">, sessionId: string | null): QueuedTask[] {
	return (sessionId ? state.tasks[sessionId] : undefined) ?? NO_TASKS;
}

const opening = new Map<string, Promise<SessionMeta>>();

export const useSide = create<SideState>((set, get) => {
	const patchTasks = (sessionId: string, update: (tasks: QueuedTask[]) => QueuedTask[]) => {
		set((state) => ({ tasks: { ...state.tasks, [sessionId]: update(sideTasksOf(state, sessionId)) } }));
	};

	return {
		sides: {},
		tasks: {},
		draftSeeds: {},
		browserTarget: null,

		openPreview: (preview, sessionId) => set({ browserTarget: { kind: "preview", preview, ...(sessionId !== undefined ? { sessionId } : {}) } }),
		openUrl: (url) => set({ browserTarget: { kind: "url", url } }),
		pendingCommand: null,
		pendingScreen: null,
		/*
		 * 只记下这条命令，开终端是调用方的事。
		 *
		 * 从前这里顺手把终端开出来，而「开在哪」在分屏之后不再有唯一答案——它得问「人在哪一屏」，
		 * 那是 `openScopedPanel` 的事，而这个文件是 dock 的底层状态，反过来依赖它会连成一个环
		 * （sideStore → popout → store → tree → sideStore，`pnpm arch` 当场报 no-circular）。
		 *
		 * 两个调用方（文件树的「在终端打开」、代码块的「在终端运行」）各自负责叫出一个终端来接。
		 */
		runInTerminal: (command, screen) => {
			set({ pendingCommand: command, pendingScreen: screen ?? null });
		},
		commandTaken: () => set({ pendingCommand: null, pendingScreen: null }),

		/**
		 * 把这个会话的任务队列和侧边聊天会话拉过来。
		 *
		 * 幂等且可并存：分屏时两屏各 attach 各的。列出来的和手上的合在一起——手上可能有一格刚刚
		 * 建出来、列表发出去时还没有它；删掉的由 `forgetSide` 拿走，不靠这里。
		 */
		async attach(sessionId) {
			if (!sessionId) return;
			await Promise.all([
				bridge.tasks.list(sessionId).then((tasks) => get().setTasks(sessionId, tasks ?? NO_TASKS), () => {}),
				bridge.sideChat.list(sessionId).then((list) => {
					const listed = Object.fromEntries(list.filter((meta) => meta.sideId).map((meta) => [meta.sideId!, meta]));
					set((state) => ({ sides: { ...state.sides, [sessionId]: { ...state.sides[sessionId], ...listed } } }));
				}, () => {}),
			]);
		},

		open(sessionId, sideId) {
			const existing = sideOf(get(), sessionId, sideId);
			if (existing) return Promise.resolve(existing);
			const key = sideKey(sessionId, sideId);
			const inFlight = opening.get(key);
			if (inFlight) return inFlight;
			const operation = bridge.sideChat.open(sessionId, sideId).then((meta) => {
				get().noteSide(meta);
				return meta;
			});
			opening.set(key, operation);
			void operation.finally(() => opening.delete(key)).catch(() => {});
			return operation;
		},

		noteSide(meta) {
			const { parentId, sideId } = meta;
			if (!parentId || !sideId) return;
			const held = sideOf(get(), parentId, sideId);
			if (held && held.id === meta.id && held.seq > meta.seq) return;
			set((state) => ({ sides: { ...state.sides, [parentId]: { ...state.sides[parentId], [sideId]: meta } } }));
		},

		forgetSide(id) {
			const parentId = sideParentOf(get(), id);
			if (!parentId) return;
			set((state) => ({
				sides: { ...state.sides, [parentId]: Object.fromEntries(Object.entries(state.sides[parentId] ?? {}).filter(([, meta]) => meta.id !== id)) },
			}));
		},

		async close(sessionId, sideId) {
			if (!sessionId) return;
			const meta = sideOf(get(), sessionId, sideId);
			if (meta) get().forgetSide(meta.id);
			try { await bridge.sideChat.close(sessionId, sideId); }
			catch (error) { console.error("[sidechat] Failed to close", error); }
		},

		async cancelTask(sessionId, taskId) {
			if (!sessionId) return;
			// Optimistic: the card should stop saying "queued" on the click, not on the round trip.
			patchTasks(sessionId, (tasks) => tasks.map((t) => (t.id === taskId && t.status === "queued" ? { ...t, status: "cancelled" } : t)));
			await bridge.tasks.cancel(sessionId, taskId);
		},

		async resumeTask(sessionId, taskId) {
			if (!sessionId) return;
			// Optimistic: the row should stop saying "interrupted" on the click.
			patchTasks(sessionId, (tasks) => tasks.map((t) => (t.id === taskId ? { ...t, status: "queued" as const, cancelledBy: undefined } : t)));
			await bridge.tasks.resume(sessionId, taskId);
		},

		async dismissTask(sessionId, taskId) {
			if (!sessionId) return;
			// Optimistic, same as cancelling: the row goes on the click.
			patchTasks(sessionId, (tasks) => tasks.filter((t) => t.id !== taskId));
			await bridge.tasks.dismiss(sessionId, taskId);
		},

		/**
		 * Put a task's text back where it was written, so it can be changed and sent again.
		 *
		 * Withdrawing a task should not throw away what it said — that is the whole reason to withdraw
		 * one rather than let it run. The composer holds its own text, so this is a seed it picks up
		 * rather than a value it is given; the counter is what makes withdrawing the same text twice
		 * register as two separate events.
		 */
		seedDraft(sessionId, sideId, text) {
			if (!sessionId) return;
			const key = sideKey(sessionId, sideId);
			set((state) => {
				const was = state.draftSeeds[key];
				return { draftSeeds: { ...state.draftSeeds, [key]: { text, quotes: was?.quotes ?? [], nonce: (was?.nonce ?? 0) + 1 } } };
			});
		},

		seedQuote(sessionId, sideId, quote) {
			if (!sessionId) return;
			const key = sideKey(sessionId, sideId);
			set((state) => {
				const was = state.draftSeeds[key];
				return { draftSeeds: { ...state.draftSeeds, [key]: { text: was?.text ?? "", quotes: [...(was?.quotes ?? []), quote], nonce: (was?.nonce ?? 0) + 1 } } };
			});
		},

		clearDraftSeed(sessionId, sideId) {
			if (!sessionId) return;
			const key = sideKey(sessionId, sideId);
			set((state) => {
				const { [key]: _taken, ...rest } = state.draftSeeds;
				return { draftSeeds: rest };
			});
		},

		setTasks: (sessionId, tasks) => set((state) => ({ tasks: { ...state.tasks, [sessionId]: tasks } })),
	};
});
