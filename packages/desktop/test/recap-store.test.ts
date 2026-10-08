/**
 * 回顾卡什么时候出现、请求回来之后怎么落。
 *
 * 出现只认「这个会话在人不在时干完了一轮」：切过去时它带着完成标记，或者窗口失焦期间屏上这个
 * 会话收了尾。其余时候——切到一个没变过的会话、窗口一直在前台——都不该出现。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

type Reply = { ok: true; recap: { text: string; covered: number; coveredAt: number; at: number } } | { ok: false; reason: "gone" | "empty" | "model" | "failed" };
let reply: () => Promise<Reply> = async () => ({ ok: true, recap: { text: "做完了", covered: 1, coveredAt: 1, at: 1 } });
const listeners = new Map<string, () => void>();

(globalThis as unknown as { window: unknown }).window = {
	addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
	removeEventListener: (type: string) => listeners.delete(type),
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	plume: { sessions: { recap: () => reply(), list: async () => [] } },
};

const { useApp } = await import("../src/store/index.ts");
const { offerRecap, dismissRecap, requestRecap, useRecaps } = await import("../src/store/recap.ts");
const { watchRecapArrivals } = await import("../src/features/conversation/recap.ts");

const message = { role: "user" as const, content: [], timestamp: 1 };
const offer = (id: string) => useRecaps.getState().offers[id];

beforeEach(() => {
	useRecaps.setState({ offers: {} });
	useApp.setState({ activeSessionId: "a", messages: [message, message], loadingSession: false, running: false, activity: {}, pendingUserMessage: null });
	reply = async () => ({ ok: true, recap: { text: "做完了", covered: 1, coveredAt: 1, at: 1 } });
});

describe("arrivals", () => {
	it("offers a recap when switching to a conversation that finished while you were elsewhere", () => {
		const stop = watchRecapArrivals();
		try {
			useApp.setState({ activeSessionId: "b", messages: [] });
			// a 在后台跑完了一轮。
			useApp.setState({ activity: { a: "done" } });
			// 打开它的那一次 set 会把标记清掉，规则要从清掉之前读。
			useApp.setState({ activeSessionId: "a", activity: {} });
			assert.equal(offer("a")?.status, "measuring");
			assert.equal(offer("a")?.since, 2, "离开时看到的条数");
		} finally {
			stop();
		}
	});

	it("does not offer one for a conversation with nothing new", () => {
		const stop = watchRecapArrivals();
		try {
			useApp.setState({ activeSessionId: "b", activity: {} });
			assert.equal(offer("b"), undefined);
		} finally {
			stop();
		}
	});

	it("offers one when the turn on screen ended while the window was in the background", () => {
		const stop = watchRecapArrivals();
		try {
			useApp.setState({ running: true });
			listeners.get("blur")?.();
			useApp.setState({ running: false, messages: [message, message, message, message] });
			listeners.get("focus")?.();
			assert.equal(offer("a")?.status, "measuring");
			assert.equal(offer("a")?.since, 2);
		} finally {
			stop();
		}
	});

	it("leaves it alone when nothing ended while away", () => {
		const stop = watchRecapArrivals();
		try {
			listeners.get("blur")?.();
			listeners.get("focus")?.();
			assert.equal(offer("a"), undefined);
		} finally {
			stop();
		}
	});

	it("keeps it through switching away and back, and through a turn nobody asked for", () => {
		const stop = watchRecapArrivals();
		try {
			offerRecap("a", null);
			useApp.setState({ activeSessionId: "b", messages: [] });
			useApp.setState({ activeSessionId: "a", messages: [message, message] });
			assert.equal(offer("a")?.status, "measuring", "切走再切回来还在");

			// 子智能体的结果送回来，主智能体自己开了一轮。
			useApp.setState({ running: true });
			useApp.setState({ running: false });
			assert.equal(offer("a")?.status, "measuring", "不是人开的口");

			// 切回来时缓存带回的是以前那一条，不算这一次发的。
			useApp.setState({ activeSessionId: "b", messages: [] });
			useApp.setState({ activeSessionId: "a", messages: [message, message], pendingUserMessage: { sessionId: "a", message } });
			assert.equal(offer("a")?.status, "measuring", "切会话带回来的旧消息");
		} finally {
			stop();
		}
	});

	it("drops it once you send something, but not for a synthetic message", () => {
		const stop = watchRecapArrivals();
		try {
			offerRecap("a", null);
			useApp.setState({ pendingUserMessage: { sessionId: "a", message: { ...message, synthetic: true } }, running: true });
			assert.equal(offer("a")?.status, "measuring");

			useApp.setState({ pendingUserMessage: { sessionId: "a", message: { ...message, timestamp: 2 } } });
			assert.equal(offer("a"), undefined);
		} finally {
			stop();
		}
	});
});

describe("requests", () => {
	it("shows the text when it comes back", async () => {
		offerRecap("a", 1);
		await requestRecap("a", false);
		assert.equal(offer("a")?.status, "ready");
		assert.equal(offer("a")?.text, "做完了");
		assert.equal(offer("a")?.since, 1);
	});

	it("says nothing when an automatic one fails, and says why when a typed one does", async () => {
		reply = async () => ({ ok: false, reason: "model" });
		offerRecap("a", 1);
		await requestRecap("a", false);
		assert.equal(offer("a"), undefined);

		await requestRecap("a", true);
		assert.equal(offer("a")?.status, "failed");
		assert.equal(offer("a")?.reason, "model");
	});

	it("drops a reply that comes back after the card was closed or asked for again", async () => {
		const gate = Promise.withResolvers<Reply>();
		reply = () => gate.promise;
		offerRecap("a", 1);
		const pending = requestRecap("a", false);
		dismissRecap("a");
		offerRecap("a", 5);
		gate.resolve({ ok: true, recap: { text: "旧的", covered: 1, coveredAt: 1, at: 1 } });
		await pending;
		assert.equal(offer("a")?.status, "measuring");
		assert.equal(offer("a")?.text, undefined);
	});
});
