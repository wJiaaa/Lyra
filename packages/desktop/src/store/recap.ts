/**
 * 回到一个会话时，输入框上方那条回顾该不该出现、现在是什么状态。
 *
 * 「回到」只认两种，都是这个会话在人不在的时候干完了一轮：
 *
 * - 切过去的时候它带着「已完成 / 失败」的标记——那正是侧栏上那颗未读的点；
 * - 窗口失焦期间，屏上这个会话的一轮跑完了，人又切回窗口。
 *
 * 不按时间算。隔了三天打开一个没变过的会话也不弹：它没有新东西，想回顾就打 `/recap`。
 *
 * 状态只活在这个窗口里。「上次看到第几条」不落盘：它只用来定新内容从哪一问量起，重启之后
 * 不知道就退回最后一个问题，不值得为它往日志里写东西。
 */

import { create } from "zustand";
import { bridge } from "../services/index.ts";
import { useApp } from "./index.ts";

export interface RecapOffer {
	/**
	 * `measuring`：等转录排好版，看新内容是不是超过一屏——一屏放得下就用不着回顾。
	 * 手动的 `/recap` 不经过这一步。
	 */
	status: "measuring" | "loading" | "ready" | "failed";
	/** 离开时转录有几条；不知道时为 null。 */
	since: number | null;
	manual: boolean;
	text?: string;
	reason?: "gone" | "empty" | "model" | "failed";
	/** 每次重新提出都换一个，晚回来的旧请求据此作废。 */
	ticket: number;
}

export const useRecaps = create<{ offers: Readonly<Record<string, RecapOffer>> }>(() => ({ offers: {} }));

let tickets = 0;

function put(sessionId: string, offer: RecapOffer | null): void {
	useRecaps.setState((state) => {
		const offers = { ...state.offers };
		if (offer) offers[sessionId] = offer;
		else if (sessionId in offers) delete offers[sessionId];
		else return state;
		return { offers };
	});
}

export function dismissRecap(sessionId: string): void {
	put(sessionId, null);
}

/** 自动的那一种：先量，量过了再请求。 */
export function offerRecap(sessionId: string, since: number | null): void {
	put(sessionId, { status: "measuring", since, manual: false, ticket: ++tickets });
}

/** 量过、值得，或者人自己打了 `/recap`：去要那几行字。 */
export async function requestRecap(sessionId: string, manual: boolean): Promise<void> {
	const current = useRecaps.getState().offers[sessionId];
	const ticket = manual ? ++tickets : current?.ticket ?? ++tickets;
	put(sessionId, { status: "loading", since: manual ? null : current?.since ?? null, manual, ticket });
	let reply: Awaited<ReturnType<typeof bridge.sessions.recap>>;
	try {
		reply = await bridge.sessions.recap(sessionId);
	} catch {
		reply = { ok: false, reason: "failed" };
	}
	const latest = useRecaps.getState().offers[sessionId];
	if (!latest || latest.ticket !== ticket) return;
	if (reply.ok) {
		put(sessionId, { ...latest, status: "ready", text: reply.recap.text });
		// 侧栏悬停卡片读的是会话列表里那一份，顺手把它带上。
		void useApp.getState().refreshSessionStats(sessionId);
	} else if (manual) put(sessionId, { ...latest, status: "failed", reason: reply.reason });
	// 自动的那一种失败了就不出声：没人要过它，摆一句「没能生成」只是噪音。
	else put(sessionId, null);
}
