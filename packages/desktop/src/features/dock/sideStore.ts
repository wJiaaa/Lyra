/**
 * State for the side chat and the task queue.
 *
 * Kept apart from the main store because it is a different conversation with a different
 * lifetime: it restores from its own snapshots and never reaches the main session log.
 * Folding it into the main store would put two transcripts behind one set of message fields
 * and invite exactly the bug that makes a side-chat reply appear in the main thread.
 *
 * **每个会话一份，不是「当前那一份」。** 分屏之后屏上同时有不止一个会话，而侧边聊天面板每一屏
 * 都能开一个——从前这里只存一份对话，谁被点到就整份换成谁的，于是两屏的侧边聊天画的是同一段
 * 内容，点一下另一屏、这一屏的侧边聊天就空了。`chats` 按会话 id 存，面板按自己那一屏的会话读，
 * 两件事才对得上。读的那一侧是 `sidechat/scope.ts`。
 *
 * **一个会话旁边也可以不止一个。** `chats` 里面还有一层，按侧边聊天的 id 分；开着哪几个由布局树
 * 记着（每个一格，见 `panel-instance.ts`）。任务队列不在这一层：它是主会话的，几个侧边聊天往同一条队里
 * 派活，所以按会话存在 `tasks` 里。
 */

import type { SideChatUpdate, Message, MessageAttachment, QueuedTask, ThinkingLevel, UserContent } from "@lyra/core";
import { DEFAULT_SIDE_CHAT_ID } from "@lyra/contract";
import { create } from "zustand";
import { reduceSideEvent, rebuildToolRuns, type SideConversation } from "./side-events.ts";

import { bridge } from "../../services/index.ts";
import type { QueuedMessage } from "../../store/queued-message.ts";
import type { PanelInstanceKind } from "../../lib/panel-instance.ts";

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
}

/**
 * 一个侧边聊天。
 *
 * `SideConversation` 是能从主进程恢复出来的那部分；这里多出来的几样只活在界面上，
 * 但同样是**这一个侧边聊天**的，不是整个窗口的——各自的加载状态、各自的思考等级、
 * 各自那句等着被放回输入框的话。
 */
export interface SideChatSlot extends SideConversation {
	loading: boolean;
	/**
	 * 这一侧自己的思考等级，`null` 表示跟着主会话走。
	 *
	 * 不落盘——模型是这个对话的属性（换了要记住），而想多久更像是「这一问要不要多花点时间」，
	 * 下次打开从主会话那边重新起算是对的。`sidechat.ts` 的 `ask` 早就收这个参数，不给才回落到
	 * 主会话，所以不传等于从前的行为。
	 */
	thinking: ThinkingLevel | null;
	/** Text waiting to be put back into the composer, and a counter so repeats still register. */
	draftSeed: { text: string; nonce: number } | null;
	/**
	 * 正在答的时候问出口的那几句，排着等这一轮答完。
	 *
	 * 从前这时候按回车什么都不发生——字留在框里，没有一句话说为什么。主会话早就是这样排的（见
	 * `store/queue-slice.ts`），条也是同一条：看得见、改得了、排得出先后。只活在界面上，不落盘。
	 */
	queued: QueuedMessage[];
}

interface SideState {
	/** `chats[会话][侧边聊天]`。没开过的在这里没有条目，读出来是 `EMPTY_SLOT`。 */
	chats: Record<string, Record<string, SideChatSlot>>;
	/** 主会话的任务队列，按会话存——几个侧边聊天派的活排在同一条队里。 */
	tasks: Record<string, QueuedTask[]>;

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
	 * Pull what this session already has: its task queue, and every side chat already on screen.
	 * Safe to call for several sessions at once.
	 */
	attach(sessionId: string | null, force?: boolean): Promise<void>;
	/** 把这一个侧边聊天的对话拉过来。面板自己叫，它知道自己是哪一个。 */
	attachChat(sessionId: string | null, sideId: string, force?: boolean): Promise<void>;
	/** 关掉一个：停下、存档删掉。 */
	close(sessionId: string | null, sideId: string): Promise<void>;
	ask(sessionId: string | null, sideId: string, content: UserContent[], meta?: SideSendMeta): Promise<void>;
	abort(sessionId: string | null, sideId: string): Promise<void>;
	reset(sessionId: string | null, sideId: string): Promise<void>;
	/** Change a question already asked and answer from there. Everything after it is dropped. */
	editAndResend(sessionId: string | null, sideId: string, index: number, content: UserContent[], meta?: SideSendMeta): Promise<void>;
	setModel(sessionId: string | null, sideId: string, modelId: string | null): Promise<void>;
	setThinking(sessionId: string | null, sideId: string, level: ThinkingLevel | null): void;
	cancelTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Take a finished row off the list. What it did, if anything, stays in the transcript. */
	dismissTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Put a stopped task back on the queue — interrupted by a pause, or failed. */
	resumeTask(sessionId: string | null, taskId: string): Promise<void>;
	/** Hand text back to the composer — see the note on the implementation. */
	seedDraft(sessionId: string | null, sideId: string, text: string): void;
	clearDraftSeed(sessionId: string | null, sideId: string): void;
	/** 排到队尾。这一轮干净答完之后，队首自己发出去。 */
	enqueue(sessionId: string | null, sideId: string, entry: Omit<QueuedMessage, "id" | "queuedAt">): void;
	/** 拿走一条并交还给调用者——删掉是丢弃，编辑是放回输入框。 */
	dropQueued(sessionId: string | null, sideId: string, id: string): QueuedMessage | null;
	moveQueued(sessionId: string | null, sideId: string, id: string, targetId: string, placement: "before" | "after"): boolean;
	applyEvent(sessionId: string, sideId: string, event: SideChatUpdate & { sideRevision?: number }): void;
	setTasks(sessionId: string, tasks: QueuedTask[]): void;
}

/**
 * 一条侧边聊天消息里「给人看的那一份」。
 *
 * 和主会话存的是同一组字段（`displayText` + `attachments`），只是从这一侧递进去。
 *
 * 不导出：输入框那边交过来的是 `composer` 的 `OutgoingMeta`，两者字段相同，按结构对得上。
 * 把它也导出去，就成了同一个概念在两个域里各有一个名字——knip 当场报的就是这件事。
 */
interface SideSendMeta {
	displayText: string;
	attachments: MessageAttachment[];
}

/** 空的就不要往消息上挂空字段——`undefined` 会被序列化成一个真的 key。 */
function displayOf(meta?: SideSendMeta): { displayText?: string; attachments?: MessageAttachment[] } {
	if (!meta) return {};
	return {
		displayText: meta.displayText,
		...(meta.attachments.length > 0 ? { attachments: meta.attachments } : {}),
	};
}

/** 正在拉快照的那几个侧边聊天，键是 `chatKey`。拉的过程中到的事件先攒在这里。 */
const reads = new Map<string, { events: (SideChatUpdate & { sideRevision?: number })[] }>();
/** 关掉了的。路上还没到的事件不能把它画回来；id 不会再用，所以只进不出。 */
const closed = new Set<string>();

function chatKey(sessionId: string, sideId: string): string {
	return `${sessionId}\0${sideId}`;
}

const EMPTY: SideConversation = {
	modelId: null,
	error: null,
	messages: [],
	toolRuns: {},
	running: false,
	pending: null,
};

/**
 * 没开过的那个会话读出来的东西。
 *
 * 一个常量而不是每次新建一个：selector 直接把它交给组件，每次换一个新对象等于每次都「变了」，
 * React 会一直重画。
 */
const NO_QUEUE: QueuedMessage[] = [];
const NO_TASKS: QueuedTask[] = [];
const EMPTY_SLOT: SideChatSlot = { ...EMPTY, loading: false, thinking: null, draftSeed: null, queued: NO_QUEUE };

/** 这一个侧边聊天。问一个没开过的不是错，答案是空的。 */
export function sideChatOf(state: Pick<SideState, "chats">, sessionId: string | null, sideId: string): SideChatSlot {
	return (sessionId ? state.chats[sessionId]?.[sideId] : undefined) ?? EMPTY_SLOT;
}

/** 这个会话主队列里的活。 */
export function sideTasksOf(state: Pick<SideState, "tasks">, sessionId: string | null): QueuedTask[] {
	return (sessionId ? state.tasks[sessionId] : undefined) ?? NO_TASKS;
}

export const useSide = create<SideState>((set, get) => {
	/** 只动这一个侧边聊天那一份，别的原样留着。 */
	const patch = (sessionId: string, sideId: string, changes: Partial<SideChatSlot> | ((slot: SideChatSlot) => Partial<SideChatSlot>)) => {
		set((state) => {
			const chats = state.chats[sessionId] ?? {};
			const slot = chats[sideId] ?? EMPTY_SLOT;
			const next = { ...slot, ...(typeof changes === "function" ? changes(slot) : changes) };
			return { chats: { ...state.chats, [sessionId]: { ...chats, [sideId]: next } } };
		});
	};

	const patchTasks = (sessionId: string, update: (tasks: QueuedTask[]) => QueuedTask[]) => {
		set((state) => ({ tasks: { ...state.tasks, [sessionId]: update(sideTasksOf(state, sessionId)) } }));
	};

	/**
	 * 发队首——只在真的空着的时候。
	 *
	 * 「先取走再发」：条上那一行要在这一刻就走，而 `ask` 自己会先把这句画进对话里。它要是被拒了
	 * （正在加载、刚好又开了一轮），放回原处，下一次答完再轮到它。
	 */
	const flush = (sessionId: string, sideId: string) => {
		const slot = sideChatOf(get(), sessionId, sideId);
		const first = slot.queued[0];
		if (!first || slot.running || slot.loading) return;
		patch(sessionId, sideId, { queued: slot.queued.slice(1) });
		const meta = first.displayText !== undefined ? { displayText: first.displayText, attachments: (first.attachments ?? []) as MessageAttachment[] } : undefined;
		void get().ask(sessionId, sideId, first.content, meta);
	};

	/**
	 * 把这一个侧边聊天的对话拉过来。
	 *
	 * 同一个正在拉的时候再叫一次会被挡掉（`reads`），`force` 是「刚刚重置过，必须重读」。
	 */
	const attachChat = async (sessionId: string, sideId: string, force = false) => {
		const key = chatKey(sessionId, sideId);
		if (reads.has(key) && !force) return;
		/*
		 * 只有从没拉过的那一次才算「加载中」。
		 *
		 * `loading` 的用途是「还没有东西可画」——面板据此画加载行，输入框据此变灰。而回到一屏
		 * 时这一份**已经在手上**，再标一次加载，界面就闪一下、输入框灰一下。
		 *
		 * 灰那一下不只是难看：`disabled` 的 textarea 接不住点击的默认聚焦行为，于是分屏里点
		 * 另一屏的侧边输入框，第一下永远落空，要点第二下才能打字。实测焦点直接留在 `body`，
		 * 而那个 textarea 自始至终是同一个节点——不是被换掉，是那一瞬间它不接受焦点。
		 */
		if (!get().chats[sessionId]?.[sideId]) patch(sessionId, sideId, { loading: true });
		const read = { events: [] as (SideChatUpdate & { sideRevision?: number })[] };
		reads.set(key, read);
		try {
			const snapshot = await bridge.sideChat.state(sessionId, sideId);
			if (reads.get(key) !== read) return;
			let next: SideConversation = { ...EMPTY, modelId: snapshot?.modelId ?? null, messages: snapshot?.messages ?? [], running: snapshot?.running ?? false,
				toolRuns: snapshot ? rebuildToolRuns(snapshot.messages) : {} };
			// Replay only events newer than the snapshot, preserving both old history and live deltas.
			for (const event of read.events) {
				if (event.sideRevision === undefined || event.sideRevision > (snapshot?.revision ?? 0)) next = reduceSideEvent(next, event);
			}
			// 界面上那几样（想多久、等着放回输入框的话）不在快照里，是这一屏自己的，留着。
			patch(sessionId, sideId, (slot) => ({ ...next, loading: false, thinking: slot.thinking, draftSeed: slot.draftSeed }));
		} catch (error) {
			if (reads.get(key) === read) patch(sessionId, sideId, { loading: false, error: String(error) });
		} finally { if (reads.get(key) === read) reads.delete(key); }
	};

	return {
		chats: {},
		tasks: {},
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
		 * 把这个会话的侧边对话拉过来。
		 *
		 * 幂等且可并存：分屏时两屏各 attach 各的，互不影响。任务队列按会话拉；侧边聊天拉的是最早那一个
		 * 和已经在手上的那几个——别的还没有面板画它们，面板出来时自己会拉（`attachChat`）。
		 */
		async attach(sessionId, force = false) {
			if (!sessionId) return;
			const sideIds = new Set([DEFAULT_SIDE_CHAT_ID, ...Object.keys(get().chats[sessionId] ?? {})]);
			await Promise.all([
				bridge.tasks.list(sessionId).then((tasks) => get().setTasks(sessionId, tasks ?? NO_TASKS), () => {}),
				...[...sideIds].map((sideId) => attachChat(sessionId, sideId, force)),
			]);
		},

		attachChat: async (sessionId, sideId, force) => {
			if (!sessionId) return;
			await attachChat(sessionId, sideId, force);
		},

		async close(sessionId, sideId) {
			if (!sessionId) return;
			const key = chatKey(sessionId, sideId);
			closed.add(key);
			reads.delete(key);
			set((state) => {
				const { [sideId]: _closed, ...rest } = state.chats[sessionId] ?? {};
				return { chats: { ...state.chats, [sessionId]: rest } };
			});
			try { await bridge.sideChat.close(sessionId, sideId); }
			catch (error) { console.error("[sidechat] Failed to close", error); }
		},

		setThinking(sessionId, sideId, level) {
			if (!sessionId) return;
			patch(sessionId, sideId, { thinking: level });
		},

		async setModel(sessionId, sideId, modelId) {
			if (!sessionId) return;
			try { await bridge.sideChat.setModel(sessionId, sideId, modelId); }
			catch (error) { get().applyEvent(sessionId, sideId, { type: "notice", level: "error", message: String(error) }); }
		},

		async ask(sessionId, sideId, content, meta) {
			if (!sessionId) return;
			const slot = sideChatOf(get(), sessionId, sideId);
			if (slot.running || slot.loading) return;

			/*
			 * Paint it first.
			 *
			 * The first question of a session activates the main agent behind the scenes, which
			 * takes a second or more. Without this the composer would clear and nothing would take
			 * its place for that whole time.
			 */
			/*
			 * 先画出来的那一条，带的也是给人看的那一份。
			 *
			 * 不带的话，消息会先以「附件正文摊在气泡里」的样子出现，等主进程回存之后再换成胶囊——
			 * 同一条消息在眼前变了一次形。
			 */
			const pending: Message = { role: "user", content, timestamp: Date.now(), ...displayOf(meta) };
			patch(sessionId, sideId, { messages: [...slot.messages, pending], pending, running: true, error: null });
			const thinking = sideChatOf(get(), sessionId, sideId).thinking;
			try { await bridge.sideChat.ask(sessionId, sideId, content, { ...(thinking ? { thinking } : {}), ...displayOf(meta) }); }
			catch (error) { get().applyEvent(sessionId, sideId, { type: "notice", level: "error", message: String(error) }); get().applyEvent(sessionId, sideId, { type: "agent_end", reason: "error", error: String(error) }); }
		},

		/**
		 * Change a question already asked, and answer from there.
		 *
		 * Everything after it goes, because it was a reply to wording that no longer exists — the same
		 * rule the main conversation follows. Painted immediately for the same reason `ask` is: the
		 * round trip is long enough that a composer clearing to nothing reads as a lost message.
		 */
		async editAndResend(sessionId, sideId, index, content, meta) {
			if (!sessionId) return;
			const slot = sideChatOf(get(), sessionId, sideId);
			if (slot.running || slot.loading) return;
			const kept = slot.messages.slice(0, index);
			const pending: Message = { role: "user", content, timestamp: Date.now(), ...displayOf(meta) };
			patch(sessionId, sideId, { messages: [...kept, pending], pending, running: true, error: null });
			try { await bridge.sideChat.editAndResend(sessionId, sideId, index, content, displayOf(meta)); }
			catch (error) { get().applyEvent(sessionId, sideId, { type: "notice", level: "error", message: String(error) }); get().applyEvent(sessionId, sideId, { type: "agent_end", reason: "error", error: String(error) }); }
		},

		async abort(sessionId, sideId) {
			if (!sessionId) return;
			try { await bridge.sideChat.abort(sessionId, sideId); }
			catch (error) { get().applyEvent(sessionId, sideId, { type: "notice", level: "error", message: String(error) }); }
		},

		async reset(sessionId, sideId) {
			if (!sessionId || sideChatOf(get(), sessionId, sideId).loading) return;
			// 重新开始：排着的那几句是问给上一段对话的，不跟过来。
			patch(sessionId, sideId, { loading: true, error: null, queued: NO_QUEUE });
			try {
				await bridge.sideChat.reset(sessionId, sideId);
				await attachChat(sessionId, sideId, true);
			} catch (error) {
				patch(sessionId, sideId, { loading: false });
				get().applyEvent(sessionId, sideId, { type: "notice", level: "error", message: String(error) });
			}
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
			patch(sessionId, sideId, (slot) => ({ draftSeed: { text, nonce: slot.draftSeed ? slot.draftSeed.nonce + 1 : 1 } }));
		},

		clearDraftSeed(sessionId, sideId) {
			if (!sessionId) return;
			patch(sessionId, sideId, { draftSeed: null });
		},

		setTasks: (sessionId, tasks) => set((state) => ({ tasks: { ...state.tasks, [sessionId]: tasks } })),

		applyEvent(sessionId, sideId, event) {
			// 已经关掉的那一个，路上还没到的事件不能把它画回来。
			if (closed.has(chatKey(sessionId, sideId))) return;
			// 正在拉快照的那一个，事件先攒着，等快照回来再按 revision 决定放不放。
			reads.get(chatKey(sessionId, sideId))?.events.push(event);
			patch(sessionId, sideId, (slot) => reduceSideEvent(slot, event));
			/*
			 * 这一轮干净答完了，排着的下一句接上。
			 *
			 * 只认 done，理由同主会话（`apply-event.ts`）：按了停止、报了错，接着把排着的灌进去是最
			 * 不该做的事——那几句留在条上，发不发由人定。推到微任务里，等这一轮的收尾先落定。
			 */
			if (event.type === "agent_end" && event.reason === "done") queueMicrotask(() => flush(sessionId, sideId));
		},

		enqueue(sessionId, sideId, entry) {
			if (!sessionId) return;
			patch(sessionId, sideId, (slot) => ({ queued: [...slot.queued, { ...entry, id: crypto.randomUUID(), queuedAt: Date.now() }] }));
			// 空着却排上了——多半是上一轮被停掉、队里还压着别的：由这一次推它一把。
			queueMicrotask(() => flush(sessionId, sideId));
		},

		dropQueued(sessionId, sideId, id) {
			if (!sessionId) return null;
			const taken = sideChatOf(get(), sessionId, sideId).queued.find((entry) => entry.id === id) ?? null;
			if (taken) patch(sessionId, sideId, (slot) => ({ queued: slot.queued.filter((entry) => entry.id !== id) }));
			return taken;
		},

		moveQueued(sessionId, sideId, id, targetId, placement) {
			if (!sessionId || id === targetId) return false;
			const list = sideChatOf(get(), sessionId, sideId).queued;
			const from = list.findIndex((entry) => entry.id === id);
			if (from < 0 || !list.some((entry) => entry.id === targetId)) return false;
			// 目标的位置在拿走之后重新找一遍——见 `queue-slice.ts` 同名的那一段。
			const without = list.toSpliced(from, 1);
			const at = without.findIndex((entry) => entry.id === targetId);
			const to = placement === "before" ? at : at + 1;
			if (to === from) return false;
			patch(sessionId, sideId, { queued: without.toSpliced(to, 0, list[from]!) });
			return true;
		},
	};
});
