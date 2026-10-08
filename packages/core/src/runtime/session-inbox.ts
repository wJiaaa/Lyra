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
	 * 有人说的话排着，循环还没取走。
	 *
	 * 等派发的地方据此不再干等（`delegation-waits.ts`）。只在人开口那一刻放手是不够的：话常常是在
	 * 模型还在写回复时说的，那段回复写完才派出子代理，开口那一刻手上没有等待可放，接下来的等待就把
	 * 这句话一直压到子代理全部跑完。人是不是在说话，判断和循环清技能限制时用的同一条（`fromPerson`）。
	 */
	get spoken(): boolean {
		return this.steering.some((message) => message.role === "user" && !message.synthetic);
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
