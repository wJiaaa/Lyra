/**
 * 每个会话的运行在事件流里的样子：哪一封信进了哪一次运行、那次运行最后说了什么、怎么收的场、
 * 此刻有没有卡在等人回答上。`wait_for_session` 据此等「收到我那封信的那一次运行」。
 *
 * 为什么不是「等对方下一次空闲、取它最后一句」：对方正忙着人交代的事、或同时有别的会话找它时，
 * 下一次空闲之前它可能跑了好几次运行，最后一句回答的是别人。照 synara 的 `wait_for_threads`，
 * 钉住具体的那一次。
 *
 * 一次运行 = `agent_start` 到 `agent_end`。插进来的消息（`steer`）发 `message_start` 时那次运行
 * 已经开始，就算进它；闲着时进来的消息先于 `agent_start` 落盘，算进下一次。开轮之前就被停下的，
 * 只有 `agent_end` 没有 `agent_start`，当作一次刚开就结束的运行。
 */

import type { AgentEvent } from "@plume/core";

type EndReason = Extract<AgentEvent, { type: "agent_end" }>["reason"];

export interface RunEnd {
	reason: EndReason;
	/** 这次运行里最后一段 assistant 文本。 */
	reply: string;
}

/** 等着人回答的一件事：审批，或模型问人的问题。 */
export interface Pending {
	requestId: string;
	title: string;
	question: boolean;
}

/** 留多少次已结束的运行：够正在等的人取，旧的不再有人问。 */
const KEEP_RUNS = 32;

interface Track {
	seq: number;
	active: boolean;
	replies: Map<number, string>;
	ended: Map<number, EndReason>;
	letters: Map<string, number>;
	pending: Map<string, Pending>;
}

export class PeerRuns {
	private readonly tracks = new Map<string, Track>();
	private readonly listeners = new Map<string, Set<() => void>>();

	/** 会话的每一个事件都过这里一遍；只记上面说的那几样。 */
	observe(sessionId: string, event: AgentEvent): void {
		const track = this.track(sessionId);
		switch (event.type) {
			case "agent_start":
				track.seq += 1;
				track.active = true;
				break;
			case "agent_end":
				if (!track.active) track.seq += 1;
				track.active = false;
				track.ended.set(track.seq, event.reason);
				this.prune(track);
				break;
			case "message_start":
				if (event.message.role !== "user" || !event.message.peer) return;
				for (const letter of event.message.peer) if (letter.id) track.letters.set(letter.id, track.active ? track.seq : track.seq + 1);
				break;
			case "message_end":
				if (event.message.role !== "assistant" || !track.active) return;
				{
					const text = event.message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
					if (text) track.replies.set(track.seq, text);
				}
				break;
			case "approval_request":
				track.pending.set(event.requestId, { requestId: event.requestId, title: event.title, question: Boolean(event.options) });
				break;
			case "approval_settled":
				track.pending.delete(event.requestId);
				break;
			default:
				return;
		}
		this.pulse(sessionId);
	}

	/** 正在跑的那一次（没在跑则为 null）。 */
	current(sessionId: string): number | null {
		const track = this.tracks.get(sessionId);
		return track?.active ? track.seq : null;
	}

	/** 下一次运行的编号：闲着时送进去的东西会开的那一次。 */
	next(sessionId: string): number {
		return (this.tracks.get(sessionId)?.seq ?? 0) + 1;
	}

	/** 这一封进了哪一次运行；还没进对话则为 undefined。 */
	runOf(sessionId: string, letterId: string): number | undefined {
		return this.tracks.get(sessionId)?.letters.get(letterId);
	}

	/** 这一次运行结束了吗；结束了就带上它怎么收的场、最后说了什么。 */
	ended(sessionId: string, run: number): RunEnd | null {
		const track = this.tracks.get(sessionId);
		const reason = track?.ended.get(run);
		return reason ? { reason, reply: track!.replies.get(run) ?? "" } : null;
	}

	/** 此刻等着人回答的那些。 */
	pending(sessionId: string): Pending[] {
		return [...(this.tracks.get(sessionId)?.pending.values() ?? [])];
	}

	/** 下一次这个会话有动静。 */
	changed(sessionId: string): Promise<void> {
		return new Promise((resolve) => {
			const set = this.listeners.get(sessionId) ?? new Set();
			set.add(resolve);
			this.listeners.set(sessionId, set);
		});
	}

	/** 会话卸载了：等它的人醒来，自己发现它不在了。 */
	forget(sessionId: string): void {
		this.tracks.delete(sessionId);
		this.pulse(sessionId);
	}

	private pulse(sessionId: string): void {
		const set = this.listeners.get(sessionId);
		if (!set) return;
		this.listeners.delete(sessionId);
		for (const resolve of set) resolve();
	}

	private track(sessionId: string): Track {
		let track = this.tracks.get(sessionId);
		if (!track) {
			track = { seq: 0, active: false, replies: new Map(), ended: new Map(), letters: new Map(), pending: new Map() };
			this.tracks.set(sessionId, track);
		}
		return track;
	}

	private prune(track: Track): void {
		const floor = track.seq - KEEP_RUNS;
		for (const map of [track.replies, track.ended]) for (const run of map.keys()) if (run <= floor) map.delete(run);
		for (const [id, run] of track.letters) if (run <= floor) track.letters.delete(id);
	}
}
