/**
 * 盯着「回到会话」的那两种时刻，由壳挂一次。什么算「回到」见 `store/recap.ts`。
 *
 * 读的是侧栏已经在维护的完成标记，而不是另记一份：两份记录迟早会对不上。
 */

import { useEffect } from "react";
import { useApp } from "../../store/index.ts";
import { dismissRecap, offerRecap } from "../../store/recap.ts";

export function useRecapArrivals(): void {
	useEffect(watchRecapArrivals, []);
}

/** 开始盯，交回取消订阅。拆出来是为了能脱离 React 测。 */
export function watchRecapArrivals(): () => void {
	const seen = new Map<string, number>();
	let away: { sessionId: string; since: number; ended: boolean } | null = null;

	const unsubscribe = useApp.subscribe((state, previous) => {
		/*
		 * 人开口了：回顾的事办完了。只认人发出去的那一条，不认「新的一轮开始」——子智能体的结果送回
		 * 来也会开始一轮，那时人还没接上。切走再切回来也不收：回顾一直留着，直到人说话或者自己点掉。
		 * 切会话那一次不算：缓存里带回来的是那个会话以前发的那条。
		 */
		const sent = state.pendingUserMessage;
		if (sent && sent !== previous.pendingUserMessage && state.activeSessionId === previous.activeSessionId && sent.message.role === "user" && !sent.message.synthetic && sent.sessionId) dismissRecap(sent.sessionId);
		if (state.activeSessionId !== previous.activeSessionId) {
			const left = previous.activeSessionId;
			if (left && !previous.loadingSession) seen.set(left, previous.messages.length);
			const arrived = state.activeSessionId;
			// 打开会话时这个标记在同一次 set 里被清掉，所以要从 previous 读。
			const outcome = arrived ? previous.activity[arrived] : undefined;
			if (arrived && (outcome === "done" || outcome === "failed")) offerRecap(arrived, seen.get(arrived) ?? null);
			return;
		}
		const id = state.activeSessionId;
		if (!id || state.running === previous.running) return;
		if (!state.running && away?.sessionId === id) away.ended = true;
	});

	const onBlur = () => {
		const { activeSessionId, messages, loadingSession } = useApp.getState();
		away = activeSessionId && !loadingSession ? { sessionId: activeSessionId, since: messages.length, ended: false } : null;
	};
	const onFocus = () => {
		const back = away;
		away = null;
		if (back?.ended && useApp.getState().activeSessionId === back.sessionId) offerRecap(back.sessionId, back.since);
	};
	window.addEventListener("blur", onBlur);
	window.addEventListener("focus", onFocus);
	return () => {
		unsubscribe();
		window.removeEventListener("blur", onBlur);
		window.removeEventListener("focus", onFocus);
	};
}
