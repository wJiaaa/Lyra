/**
 * 一个够路由器用的会话：收到的信记进 `inbox`，运行、审批由测试一步步拨，事件照真的那样交给路由器。
 */

import { DEFAULT_SETTINGS, type AgentEvent, type AgentSession, type PeerLetter, type PermissionMode, type Settings } from "@plume/core";
import { createPeerRouter, type PeerRouter } from "../../electron/session-peers.ts";

export type FakeSession = ReturnType<typeof fakeSession>;

export function fakeSession(id: string, cwd: string, mode: PermissionMode = "auto") {
	const inbox: { letter: PeerLetter; deliver: "steer" | "followUp" }[] = [];
	let idle = true;
	let active = false;
	let wake: (() => void)[] = [];
	/** 收到、还没进对话的那几封：它们还在，会话就不算闲（`AgentSession.idle` 也看攒着和排着的）。 */
	const unread = new Set<number>();
	let emit: (event: AgentEvent) => void = () => {};
	const messages: { role: string; content: { type: string; text: string }[] }[] = [{ role: "assistant", content: [{ type: "text", text: `${id.slice(0, 4)} 说：做完了。` }] }];
	const settle = () => {
		if (unread.size > 0) return;
		idle = true;
		for (const resolve of wake) resolve();
		wake = [];
	};
	const session = {
		meta: { id, title: id.slice(0, 4), updatedAt: 1 },
		cwd,
		messages,
		settingsInEffect: { ...DEFAULT_SETTINGS, permissionMode: mode },
		get idle() { return idle; },
		whenIdle: () => new Promise<void>((resolve) => { if (idle) resolve(); else wake.push(resolve); }),
		receive: (letter: PeerLetter, deliver: "steer" | "followUp" = "steer") => {
			unread.add(inbox.push({ letter, deliver }) - 1);
			// 攒着待送的那四百毫秒也不算闲，和 `AgentSession.idle` 一样。
			idle = false;
		},
	};
	return {
		session: session as unknown as AgentSession,
		inbox,
		connect(router: PeerRouter) { emit = (event) => router.observe(id, event); },
		/** 一次运行开始（人开口、或闲着时收到的信开了一轮）。 */
		start() {
			idle = false;
			active = true;
			emit({ type: "agent_start", sessionId: id });
		},
		/** 收到的第 `index` 封进了对话：在跑就算这一次，没在跑就算下一次。 */
		read(index = inbox.length - 1) {
			idle = false;
			unread.delete(index);
			emit({ type: "message_start", message: { role: "user", synthetic: true, timestamp: 0, peer: [inbox[index]!.letter], content: [] } as never });
		},
		/** 这一次运行说了 `reply`，收场。 */
		finish(reply?: string, reason: "done" | "aborted" = "done") {
			if (reply) {
				const message = { role: "assistant", content: [{ type: "text", text: reply }] };
				messages.push(message);
				if (active) emit({ type: "message_end", message } as never);
			}
			active = false;
			emit({ type: "agent_end", reason });
			settle();
		},
		/** 卡在等人回答上。 */
		ask(requestId: string, title: string) {
			emit({ type: "approval_request", requestId, toolCallId: "c", kind: "bash", title, detail: "", subject: "" } as never);
		},
		answered(requestId: string) { emit({ type: "approval_settled", requestId }); },
		/** 人在信送进去之前按了停：攒着的跟着丢掉，它闲了。 */
		stopBeforeReading() {
			unread.clear();
			settle();
		},
		/** 忙着别的，没有运行事件（比如任务队列里还有一件）。 */
		busy() { idle = false; },
	};
}

export function routerWith(...live: FakeSession[]) {
	const sessions = live.map((one) => one.session);
	const settings: Settings = { ...DEFAULT_SETTINGS };
	const router = createPeerRouter({ live: () => sessions, settings: () => settings });
	for (const one of live) one.connect(router);
	return { router, sessions };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
