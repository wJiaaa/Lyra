import { readFileChange, undoFileChangeBatches, type SessionStorage } from "@plume/core";
import { sessions } from "./session-hub.ts";

export type { DeliveryFile, TurnDelivery } from "./delivery-record.ts";
import { collectDelivery, deliveryMessages, type TurnDelivery } from "./delivery-record.ts";
export async function sessionDelivery(store: SessionStorage, sessionId: string, timestamp: number): Promise<TurnDelivery> {
	const live = sessions.get(sessionId);
	const meta = live?.meta ?? (await store.listSessions()).find((entry) => entry.id === sessionId);
	if (!meta) throw new Error("会话不存在");
	const messages = live?.messages ?? (await store.load(meta.projectId, sessionId))?.messages;
	if (!messages) throw new Error("会话记录不存在");
	return collectDelivery(sessionId, meta.cwd, deliveryMessages(messages, timestamp), timestamp);
}
export async function undoDeliveryFile(store: SessionStorage, sessionId: string, timestamp: number, path?: string): Promise<void> {
	const delivery = await sessionDelivery(store, sessionId, timestamp);
	const files = path === undefined ? delivery.files : delivery.files.filter((entry) => entry.path === path);
	if (!files.length || files.some((file) => !file.canUndo)) throw new Error("文件没有可安全撤销的本轮改动");
	const meta = (await store.listSessions()).find((entry) => entry.id === sessionId);
	if (!meta || [...sessions.values()].some((session) => session.cwd === meta.cwd && session.running)) throw new Error("项目仍有任务运行，请结束后再撤销");
	await undoFileChangeBatches(meta.cwd, await Promise.all(files.map((file) => Promise.all(file.changeIds.map((id) => readFileChange(sessionId, id))))));
}
