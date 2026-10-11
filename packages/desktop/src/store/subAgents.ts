/**
 * What the window knows about the work this session has delegated.
 *
 * Two halves, kept apart on purpose. The roster — who is running, how long, how many tool calls —
 * arrives as an event on every change, because it is a dozen small rows and the whole point is
 * that it is live. The transcripts are pulled per sub-agent and then kept up to date by the
 * messages that stream in, because a delegated run can read forty files and broadcasting all of
 * that on every change would put the run on the wire dozens of times over.
 *
 * The live fields are keyed by nothing: they belong to the session in the live slot, and when that
 * changes they are emptied — a sub-agent belongs to the conversation that dispatched it, and
 * showing one under another conversation would be a lie about where the work came from. With two
 * screens the other conversation is on display too, so every roster is also kept by session id in
 * `rosters`, and a screen reads its own through `useScopedSubAgents`.
 */

import { create } from "zustand";
import type { HookRun, Message, SubAgentSummary } from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { bridge } from "../services/index.ts";

interface SubAgentState {
	/** The roster, oldest first — the order a tab strip reads in. */
	agents: SubAgentSummary[];
	/** Transcripts, by sub-agent id, for the ones that have been opened. */
	transcripts: Record<string, Message[]>;
	/** 它们跑过的钩子，和转录同进同出：打开时一起读，之后跟着事件补。 */
	hookRuns: Record<string, HookRun[]>;
	/** Which one the pane is showing, or null for none open yet. */
	focused: string | null;
	/**
	 * Ids whose transcript has been asked for but not yet arrived.
	 *
	 * Held so a second click while the first read is in flight does not ask again, and so the pane
	 * can say "loading" rather than "empty" — which for a sub-agent that has genuinely said nothing
	 * yet are two different and equally believable states.
	 */
	loading: string[];
	/**
	 * The last roster each conversation broadcast, by session id.
	 *
	 * The fields above are the conversation in the live slot. With two screens the other one is on
	 * screen too — its sub-agent bar and panel have to show *its* agents, not the focused
	 * conversation's, and its broadcasts arrive while it is not the live one.
	 */
	rosters: Record<string, SubAgentSummary[]>;
	/**
	 * 每个会话最近一次收尾的时刻。
	 *
	 * 输入框上方那条据此收起：在这之前结束的子智能体，它们的结果已经进了那一轮，这一行就没什么
	 * 可说的了（见 `barAgents`）。记在这里而不是那个组件里，因为收尾可能发生在人没看着这个会话的
	 * 时候——切回来时那一行不该又冒出来。
	 */
	settled: Record<string, number>;
	settle(sessionId: string): void;

	/** Take the roster the session in the live slot just broadcast. */
	sync(agents: SubAgentSummary[], sessionId?: string): void;
	/** Keep the roster a conversation that is not in the live slot just broadcast. */
	retain(sessionId: string, agents: SubAgentSummary[]): void;
	/** A conversation's finished sub-agents were put away. */
	forgetFinished(sessionId: string): void;
	/** One message, as the sub-agent writes it. Ignored for a transcript nobody has opened. */
	append(id: string, message: Message): void;
	/** One hook run, started or settled. Ignored for a transcript nobody has opened, like `append`. */
	hookRun(id: string, run: HookRun): void;
	focus(id: string | null): void;
	/**
	 * 有人要看某一个——在对话里点了它的派发卡片。
	 *
	 * 翻到它那一页之外，还要把面板打开；而打开面板是 dock 的事，对话那一侧够不着它（从对话里
	 * 直接引 dock，会在依赖图上绕出一个新的环）。所以这里只记下「谁、在哪个会话里、什么时候」，
	 * 由输入框上方那条状态条——它本来就负责在派活时把面板打开——看到之后去开。
	 */
	revealed: { id: string; sessionId: string | null; at: number } | null;
	reveal(id: string, sessionId: string | null): void;
	/** Read one sub-agent's transcript. Idempotent while a read is in flight. */
	load(sessionId: string, id: string): Promise<void>;
	/** A different conversation is in front of you; this one's delegated work is not. */
	clear(): void;
}

export const useSubAgents = create<SubAgentState>((set, get) => ({
	agents: [],
	transcripts: {},
	hookRuns: {},
	focused: null,
	loading: [],
	rosters: {},
	settled: {},
	revealed: null,

	settle(sessionId) {
		set({ settled: { ...get().settled, [sessionId]: Date.now() } });
	},

	reveal(id, sessionId) {
		set({ focused: id, revealed: { id, sessionId, at: Date.now() } });
	},

	retain(sessionId, agents) {
		set({ rosters: { ...get().rosters, [sessionId]: agents } });
	},

	forgetFinished(sessionId) {
		const kept = (get().rosters[sessionId] ?? []).filter((one) => isActive(one));
		set({ rosters: { ...get().rosters, [sessionId]: kept } });
	},

	sync(agents, sessionId) {
		const { focused } = get();
		set({
			...(sessionId ? { rosters: { ...get().rosters, [sessionId]: agents } } : {}),
			agents,
			/*
			 * Keep looking at what you were looking at.
			 *
			 * The roster is re-sent on every tool call of every sub-agent, so anything derived from
			 * it here has to be stable — moving the pane to the newest one because a *sibling* made
			 * a tool call would make reading a long run impossible.
			 */
			focused: focused && agents.some((one) => one.id === focused) ? focused : (focused ?? null),
		});
	},

	append(id, message) {
		const existing = get().transcripts[id];
		// Nothing has been opened for this one, so there is no list to keep in step. Opening it
		// later reads the whole thing, including this.
		if (!existing) return;
		/*
		 * Already read by `load`, and only now announced.
		 *
		 * The main process records a message, writes it to disk, and only then broadcasts it; a read
		 * landing in that gap carries the message, and the broadcast arriving after it showed the same
		 * bubble twice. Compared by value because both copies crossed IPC and share no identity.
		 */
		if (existing.some((one) => sameMessage(one, message))) return;
		set({ transcripts: { ...get().transcripts, [id]: [...existing, message] } });
	},

	hookRun(id, run) {
		if (!get().transcripts[id]) return;
		set({ hookRuns: { ...get().hookRuns, [id]: upsert(get().hookRuns[id] ?? [], run) } });
	},

	focus(id) {
		set({ focused: id });
	},

	async load(sessionId, id) {
		const { transcripts, loading } = get();
		if (transcripts[id] || loading.includes(id)) return;
		set({ loading: [...loading, id] });
		try {
			const detail = await bridge.subAgents.detail(sessionId, id);
			/*
			 * Merged, not replaced.
			 *
			 * Messages can stream in while the read is in flight, and `append` drops them because
			 * there is no list yet. Taking whichever is longer is enough: both are prefixes of the
			 * same transcript, and the read is the one that started earlier.
			 */
			const arrived = detail?.messages ?? [];
			const since = get().transcripts[id] ?? [];
			// 读的时候到了的那几条钩子更新，压在读回来的那份上面。
			const runs = (get().hookRuns[id] ?? []).reduce(upsert, detail?.hookRuns ?? []);
			set({
				transcripts: { ...get().transcripts, [id]: arrived.length >= since.length ? arrived : since },
				hookRuns: { ...get().hookRuns, [id]: runs },
			});
		} finally {
			set({ loading: get().loading.filter((each) => each !== id) });
		}
	},

	clear() {
		set({ agents: [], transcripts: {}, hookRuns: {}, focused: null, loading: [] });
	},
}));

/** 同一条钩子先报开始、再报结局，按 id 换掉；两次的位置运行时盖的是同一个（`SubAgentRegistry.hookRun`）。 */
function upsert(runs: readonly HookRun[], run: HookRun): HookRun[] {
	const at = runs.findIndex((known) => known.id === run.id);
	return at < 0 ? [...runs, run] : runs.map((known, index) => (index === at ? run : known));
}

/** Role and timestamp first: cheap, and they rule out almost every pair before the full comparison. */
function sameMessage(a: Message, b: Message): boolean {
	return a.role === b.role && a.timestamp === b.timestamp && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Running first, then the ones queued behind the gate, then the finished ones — which is the order
 * they are worth reading in.
 */
export function rosterOrder(agents: SubAgentSummary[]): SubAgentSummary[] {
	const rank = (one: SubAgentSummary) => (one.status === "running" ? 0 : one.status === "queued" ? 1 : 2);
	return [...agents].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
}

/** 还没完：在跑，或者在闸门后面排着。 */
export function isActive(one: Pick<SubAgentSummary, "status">): boolean {
	return one.status === "running" || one.status === "queued";
}

/**
 * 主会话此刻卡在它派出去的子代理上。
 *
 * 人这时候说的话不该排在它们后面：主会话不是在干活，是在等——等的那十几分钟里，排着的消息一句都
 * 发不出去（2026-09-26 的真实会话）。人一开口，运行时就让主会话放手（`delegation-waits.ts`），
 * 所以这时候消息应当直接送进去，而不是在输入框上方排队。
 *
 * 转到后台的那些不算：主会话已经不等它们了。
 */
export function awaitingSubAgents(roster: readonly SubAgentSummary[]): boolean {
	return roster.some((one) => isActive(one) && !one.background);
}

/** What a sub-agent has spent, in the two numbers a person reads: tokens, and dollars when priced. */
export interface RosterFigures {
	tokens: number;
	/** 0 when the model has no pricing — which is "unknown", and is shown as nothing rather than as free. */
	cost: number;
}

/**
 * Fresh tokens, matching the session card and the usage page — see `freshTokens`.
 *
 * A sub-agent is dispatched precisely when the work is too big for the main thread, so it runs the
 * longest tool loops in the app and re-reads its context the most. Reporting `usage.total` here
 * made every roster row read as though delegating were ruinously expensive, when most of what it
 * counted was the same context being read back at a tenth of the rate.
 */
export function figuresOf(agent: SubAgentSummary): RosterFigures {
	return { tokens: agent.usage ? freshTokens(agent.usage) : 0, cost: agent.usage?.cost.total ?? 0 };
}
