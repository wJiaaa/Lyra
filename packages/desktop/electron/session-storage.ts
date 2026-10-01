import type { SessionStorage } from "@plume/core";
import type { SessionChange } from "./ipc-shapes.ts";

/** Observe committed writes at the shared IPC/RPC boundary, including cold sessions. */
export function observeSessionStorage(store: SessionStorage, changed: (change: SessionChange) => void): SessionStorage {
	return {
		async create(...args) {
			const meta = await store.create(...args);
			changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async append(...args) {
			const meta = await store.append(...args);
			// Token updates already travel over the agent stream; only directory changes need a push.
			// Null is a write that landed after its session was deleted: announcing it would put the session back in the sidebar.
			if (meta && args[1].type !== "event") changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async setArchived(...args) {
			const meta = await store.setArchived(...args);
			if (meta) changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		/*
		 * 推出去的 `projectId` 是**新**的那个，这正是侧边栏据以换组的依据：收到的一方按 id 找到
		 * 原来那条、整条换成这一份（见渲染层的 `applySessionChange`），于是它就从旧项目底下消失、
		 * 在新项目底下出现。
		 */
		async move(...args) {
			const meta = await store.move(...args);
			if (meta) changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async truncateFrom(...args) {
			const result = await store.truncateFrom(...args);
			if (result) changed({ id: result.meta.id, projectId: result.meta.projectId, meta: result.meta });
			return result;
		},
		async delete(id) {
			const meta = await store.get(id);
			await store.delete(id);
			if (meta) changed({ id, projectId: meta.projectId, meta: null });
		},
		async deleteMany(ids) {
			const gone = (await Promise.all(ids.map((id) => store.get(id)))).filter((meta) => meta !== null);
			await store.deleteMany(ids);
			for (const meta of gone) changed({ id: meta.id, projectId: meta.projectId, meta: null });
		},
		get: (...args) => store.get(...args),
		read: (...args) => store.read(...args),
		messages: (...args) => store.messages(...args),
		/*
		 * Opening a conversation can commit the reply a dead writer left behind (`settlePartial`).
		 * That changes its meta inside the store, where no wrapper sees a write, so the sidebar is told
		 * here — by the one read that opening a conversation always goes through.
		 */
		async load(...args) {
			const before = await store.get(args[0]);
			const loaded = await store.load(...args);
			if (loaded && before && loaded.meta.seq !== before.seq) changed({ id: loaded.meta.id, projectId: loaded.meta.projectId, meta: loaded.meta });
			return loaded;
		},
		listSessions: () => store.listSessions(),
		// Startup maintenance runs before clients connect.
		pruneEmpty: (...args) => store.pruneEmpty(...args),
		// Streaming a reply and the settings pages' reads change nothing the sidebar shows.
		beginPartial: (...args) => store.beginPartial(...args),
		appendPartial: (...args) => store.appendPartial(...args),
		dropPartial: (...args) => store.dropPartial(...args),
		recordUsage: (...args) => store.recordUsage(...args),
		readSpend: (...args) => store.readSpend(...args),
		storeId: () => store.storeId(),
		activeDays: () => store.activeDays(),
		sizes: () => store.sizes(),
	};
}
