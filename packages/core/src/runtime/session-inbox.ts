/**
 * Messages that arrived while the session was busy, waiting to get in.
 *
 * Two kinds, kept apart because that difference is the whole point: a steering message is spliced
 * into the turn that is running, a queued one waits for that turn to end. One queue for both would
 * leave one of the two meanings impossible to say.
 */

import type { Message, ThinkingLevel } from "../types.ts";

export interface Queued {
	message: Message;
	thinking?: ThinkingLevel;
}

/**
 * 有人在找这个会话：人说的话，或另一个会话插进来的信。父会话据此不再干等它派出去的子代理。
 *
 * 信也算，是因为它和人插话一样在等这边读到——发信的那一方常常正卡在 `wait_for_session` 上；
 * 只认人的时候，一封插进来的信要压到子代理全部跑完才被读到（实测等一次子代理平均七分多钟）。
 * 后台结果的送达不算：它是在交差，不是在找人；算上的话，一个放了手的子代理跑完，会把其余还在
 * 等的也一并放掉。
 */
export function addressed(message: Message): boolean {
	return message.role === "user" && (!message.synthetic || message.peer !== undefined);
}

export class SessionInbox {
	private steering: Message[] = [];
	private readonly queued: Queued[] = [];

	/**
	 * Steer or queue a message said mid-turn. Returns which it did.
	 *
	 * Steering is the default, because almost everything said mid-turn is "wait, not like that" —
	 * and said five minutes late it is said for nothing. `followUp` means "after this turn", and
	 * splicing it in would interrupt the very thing it asked to finish first. A message also queues
	 * when nobody would take steering right now (`steerable`, see `SessionActivity`).
	 */
	accept(entry: Queued, deliver: "steer" | "followUp" | undefined, steerable: boolean): "steer" | "queue" {
		if (deliver === "followUp" || !steerable) {
			this.queued.push(entry);
			return "queue";
		}
		this.steering.push(entry.message);
		return "steer";
	}

	/** What the running loop picks up between rounds (`drainSteering`). */
	takeSteering(): Message[] {
		return this.steering.splice(0, this.steering.length);
	}

	/**
	 * 有人找这个会话的话排着，循环还没取走。
	 *
	 * 等派发的地方据此不再干等（`delegation-waits.ts`）。只在开口那一刻放手是不够的：话常常是在
	 * 模型还在写回复时说的，那段回复写完才派出子代理，开口那一刻手上没有等待可放，接下来的等待就把
	 * 这句话一直压到子代理全部跑完。谁算「有人找」见 `addressed`。
	 */
	get spoken(): boolean {
		return this.steering.some(addressed);
	}

	get empty(): boolean {
		return this.queued.length === 0 && this.steering.length === 0;
	}

	/**
	 * The next message to run a turn for, once the turn before it has ended.
	 *
	 * Steering nobody took is caught here too. By now the loop has ended and will not call
	 * `drainSteering` again, so anything still in `steering` is an orphan. An orphan raises no error,
	 * never reaches the transcript and is not back on the queue strip: on screen it is "sent, and
	 * nothing happened", and it is flushed out along with the next send, which looks like an old
	 * message being replayed. The `steerable` check closes the one known way in; this closes "is
	 * there another way in" — the kind of failure that should not rest on reasoning that it cannot
	 * happen. Ahead of the queue, because it was said earlier.
	 */
	next(): Queued | undefined {
		if (this.steering.length > 0) this.queued.unshift(...this.takeSteering().map((message) => ({ message })));
		return this.queued.shift();
	}

	/**
	 * Drop everything waiting: stop means this conversation stops now, not "stop this turn, then run
	 * the three I queued" — that would go on spending after the screen has just said it stopped.
	 */
	clear(): void {
		this.steering.length = 0;
		this.queued.length = 0;
	}
}
