/**
 * 在跑的会话之间互相发现、发消息、等对方做完。照 t3code 的线程工具（`t3_thread_send` /
 * `t3_thread_wait`）：
 *
 * - **发**：消息进对方的对话，闲着开一轮；忙着默认排到它手上这一轮之后，`steer` 才插进去——
 *   插进去等于打断它正在做的事。信进会话之后怎么走是 core 的事：`AgentSession.receive`。
 * - **等**：要结果的一方自己调 `wait_for_session`，等的是收到那封信的那一次运行（`peer-runs.ts`），
 *   那次运行最后那段话作为这次调用的返回值回来。发件方那一轮本来就没结束，所以不需要运行时另递
 *   「它闲了」的回执，也不会因为回执多开一轮——最初是那样做的，人看到的是一件事被切成了好几截。
 *   对方卡在等它的人回答上时，等待当场返回，让发件方去告诉人，而不是干等到超时。
 * - **权限**：对方的权限模式比自己宽，不让发（见 `peer-policy.ts`）。
 *
 * 路由只在主进程里：桌面端是单实例，所有会话都在 `session-hub.ts` 的那张表里，不需要 socket、
 * token 那一层。只认在跑的会话、目录要重叠（见 `peer-reach.ts`）。设计见
 * docs/architecture/session-messaging.md。
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSession, PeerLetter, PermissionMode, Settings } from "@plume/core";
import { peerAddress, resolvePeer } from "./peer-address.ts";
import { broaderThan, PeerPacer, type PaceRefusal } from "./peer-policy.ts";
import { rootsOverlap, sessionRoots } from "./peer-reach.ts";
import { PeerRuns, type Pending, type RunEnd } from "./peer-runs.ts";

/** 等对方做完，默认等多久、最多等多久（秒）。到点只是不等了，对方照常干。 */
export const WAIT_DEFAULT_S = 600;
export const WAIT_MAX_S = 1800;
/** 等到之后带回对方那段回复的多少字：够读结论，长报告该让对方写进文件。 */
export const REPLY_LIMIT = 4000;

export interface PeerHost {
	/** 已经起来、没在退场的会话。 */
	live(): AgentSession[];
	/** 应用的设置，没叠项目层。 */
	settings(): Settings;
}

/** `list_sessions` 的一行；地址就是 `send_message` 和 `wait_for_session` 的 `to`。 */
export interface PeerRow {
	address: string;
	sessionId: string;
	cwd: string;
	busy: boolean;
	mode: PermissionMode;
}

/** 找对方时可能落空的几种，`send` 和 `wait` 共用。 */
type Missed =
	| { kind: "unreachable"; to: string }
	| { kind: "none" }
	| { kind: "self" }
	| { kind: "ambiguous"; candidates: string[] };

export type SendOutcome =
	| Missed
	| { kind: "delivered"; to: string; busy: boolean; queued: boolean }
	| { kind: "broader"; to: string; theirs: PermissionMode; mine: PermissionMode }
	| { kind: "paced"; to: string; reason: PaceRefusal; length: number; chain: number };

export type WaitOutcome =
	| Missed
	| { kind: "done"; to: string; reply: string; cut: number; reason: RunEnd["reason"]; waitedMs: number }
	| { kind: "blocked"; to: string; pending: Pending[] }
	| { kind: "dropped"; to: string }
	| { kind: "timeout"; to: string; seconds: number }
	| { kind: "closed"; to: string }
	| { kind: "stopped"; to: string }
	| { kind: "deadlock"; to: string };

export function createPeerRouter(host: PeerHost) {
	const pacer = new PeerPacer();
	/** 每个会话此刻在接哪条链：最近送进去的那封信的链，人开口时清掉。 */
	const chains = new Map<string, string[]>();
	/** 谁正在等谁。顺着它走回到自己，就是互相死等。 */
	const waiting = new Map<string, string>();
	const runs = new PeerRuns();
	/** 发件方→收件方最近那一封的 id：`wait` 等的是收到它的那一次运行。 */
	const sent = new Map<string, string>();
	/** 每个发件方已经被告知过的「对方在等人回答」：同一件事只报一次，再等就等它被回答。 */
	const reported = new Map<string, Set<string>>();
	const pair = (from: string, to: string) => `${from}\u0000${to}`;

	const find = (id: string) => host.live().find((session) => session.meta.id === id);
	const address = (session: AgentSession) => peerAddress({ id: session.meta.id, title: session.meta.title, cwd: session.cwd });
	const identity = (session: AgentSession) => ({ id: session.meta.id, title: session.meta.title, cwd: session.cwd, session });

	async function reachable(from: AgentSession, to: AgentSession): Promise<boolean> {
		const projects = host.settings().projects;
		const [mine, theirs] = await Promise.all([sessionRoots(from.cwd, projects), sessionRoots(to.cwd, projects)]);
		return rootsOverlap(mine, theirs);
	}

	/** 解析地址、查目录重叠。自己也在候选里：拿自己的地址来，该告诉它「这是你自己」而不是「没这个人」。 */
	async function lookup(from: AgentSession, to: string): Promise<Missed | { kind: "found"; target: AgentSession; to: string }> {
		const found = resolvePeer(to, host.live().map(identity));
		if (found.kind === "none") return { kind: "none" };
		if (found.kind === "ambiguous") return { kind: "ambiguous", candidates: found.candidates.map((one) => address(one.session)) };
		const target = found.peer.session;
		if (target === from) return { kind: "self" };
		const name = address(target);
		if (!(await reachable(from, target))) return { kind: "unreachable", to: name };
		return { kind: "found", target, to: name };
	}

	/** `from` 等 `target` 会不会绕回来等到自己头上。 */
	function waitsOn(target: string, from: string): boolean {
		const seen = new Set<string>();
		for (let at: string | undefined = target; at && !seen.has(at); at = waiting.get(at)) {
			if (at === from) return true;
			seen.add(at);
		}
		return false;
	}

	return {
		/** `from` 看得见的会话：在跑、不是自己、目录重叠。 */
		async list(fromId: string): Promise<PeerRow[]> {
			const from = find(fromId);
			if (!from) return [];
			const others = host.live().filter((session) => session.meta.id !== fromId);
			const visible = await Promise.all(others.map(async (session) => ((await reachable(from, session)) ? session : null)));
			return visible
				.filter((session): session is AgentSession => session !== null)
				.map((session) => ({ address: address(session), sessionId: session.meta.id, cwd: session.cwd, busy: !session.idle, mode: session.settingsInEffect.permissionMode }));
		},

		async send(fromId: string, input: { to: string; message: string; steer?: boolean }): Promise<SendOutcome> {
			const from = find(fromId);
			if (!from) return { kind: "none" };
			const found = await lookup(from, input.to);
			if (found.kind !== "found") return found;
			const { target, to } = found;
			const text = input.message.trim();

			const mine = from.settingsInEffect.permissionMode;
			const theirs = target.settingsInEffect.permissionMode;
			if (broaderThan(theirs, mine)) return { kind: "broader", to, theirs, mine };

			const chain = [...(chains.get(fromId) ?? []), fromId];
			const refusal = pacer.admit(fromId, target.meta.id, text, chain);
			if (refusal) return { kind: "paced", to, reason: refusal, length: text.length, chain: chain.length };

			const busy = !target.idle;
			const letter: PeerLetter = { id: randomUUID(), sessionId: fromId, from: address(from), text, cwd: from.cwd, chain };
			chains.set(target.meta.id, chain);
			sent.set(pair(fromId, target.meta.id), letter.id!);
			target.receive(letter, input.steer ? "steer" : "followUp");
			return { kind: "delivered", to, busy, queued: busy && !input.steer };
		},

		/**
		 * 等收到最近那封信的那一次运行结束，带回它最后那段话。没给它发过信：照 t3code，闲着立刻
		 * 返回它最后那句，忙着就等手上这一次。
		 */
		async wait(fromId: string, input: { to: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<WaitOutcome> {
			const from = find(fromId);
			if (!from) return { kind: "none" };
			const found = await lookup(from, input.to);
			if (found.kind !== "found") return found;
			const { target, to } = found;
			const id = target.meta.id;
			if (waitsOn(id, fromId)) return { kind: "deadlock", to };

			const started = Date.now();
			const done = (end: RunEnd): WaitOutcome => ({ kind: "done", to, ...clip(end.reply), reason: end.reason, waitedMs: Date.now() - started });
			const letter = sent.get(pair(fromId, id));
			let run = letter ? undefined : (runs.current(id) ?? (target.idle ? undefined : runs.next(id)));
			if (!letter && run === undefined) return done({ reason: "done", reply: lastReply(target) });

			const seconds = Math.min(WAIT_MAX_S, Math.max(1, Math.round(input.timeoutSeconds ?? WAIT_DEFAULT_S)));
			const deadline = started + seconds * 1000;
			const told = reported.get(fromId) ?? new Set<string>();
			reported.set(fromId, told);
			waiting.set(fromId, id);
			try {
				for (;;) {
					if (!find(id)) return { kind: "closed", to };
					if (letter) run = runs.runOf(id, letter);
					const end = run === undefined ? null : runs.ended(id, run);
					if (end) return done(end);
					// 信还没进对话，它却已经闲了：攒着待送的时候被人按了停，信跟着丢了。
					if (run === undefined && target.idle) return { kind: "dropped", to };
					const fresh = runs.pending(id).filter((one) => !told.has(one.requestId));
					if (fresh.length > 0) {
						for (const one of fresh) told.add(one.requestId);
						return { kind: "blocked", to, pending: fresh };
					}
					// 事件里没看到收场（宿主没把事件交过来），它却闲了：不再等，拿对话里最后那句。
					if (target.idle) return done({ reason: "done", reply: lastReply(target) });
					const woke = await wake(target, deadline, input.signal);
					if (woke === "timeout") return { kind: "timeout", to, seconds };
					if (woke === "stopped") return { kind: "stopped", to };
				}
			} finally {
				waiting.delete(fromId);
			}

			async function wake(session: AgentSession, until: number, signal?: AbortSignal): Promise<"changed" | "timeout" | "stopped"> {
				let timer: ReturnType<typeof setTimeout> | undefined;
				let onAbort: (() => void) | undefined;
				try {
					return await Promise.race([
						runs.changed(session.meta.id).then(() => "changed" as const),
						session.whenIdle().then(() => "changed" as const),
						new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, until - Date.now())); }),
						new Promise<"stopped">((resolve) => {
							if (signal?.aborted) return resolve("stopped");
							onAbort = () => resolve("stopped");
							signal?.addEventListener("abort", onAbort, { once: true });
						}),
					]);
				} finally {
					clearTimeout(timer);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
				}
			}
		},

		/** 每个会话的事件都交过来一份：路由器据此知道哪封信进了哪一次运行、它有没有在等人。 */
		observe(sessionId: string, event: AgentEvent): void {
			runs.observe(sessionId, event);
		},

		/** 人开口了：之后这个会话发出去的信是一条新链，不再接着别人的那条。 */
		personSpoke(sessionId: string): void {
			chains.delete(sessionId);
		},

		/** 会话要被卸载了。等它的那一方由 `whenIdle` 兑现后自己发现它不在了。 */
		forget(sessionId: string): void {
			chains.delete(sessionId);
			waiting.delete(sessionId);
			reported.delete(sessionId);
			// 它发出去的、发给它的都清掉：它再起来是新的一套运行编号，旧的那封对不上了。
			for (const key of sent.keys()) if (key.split("\u0000").includes(sessionId)) sent.delete(key);
			runs.forget(sessionId);
		},
	};
}

export type PeerRouter = ReturnType<typeof createPeerRouter>;

/** 它最后那段 assistant 文本。交回建议的会话也读这一段，见 `session-report-back.ts`。 */
export function lastReply(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index]!;
		if (message.role !== "assistant") continue;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
		if (text) return text;
	}
	return "";
}

/** 太长的截掉，记下截了多少：说明里要告诉模型怎么拿到其余的部分。 */
function clip(text: string): { reply: string; cut: number } {
	return text.length > REPLY_LIMIT ? { reply: text.slice(0, REPLY_LIMIT), cut: text.length - REPLY_LIMIT } : { reply: text, cut: 0 };
}
