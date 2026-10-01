import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { AgentEvent, SessionMeta, TrajectoryChanges } from "@plume/core";
import type { Entry } from "@plume/core/trajectory-view";
import { useApp } from "../../src/store/index.ts";
import { useTrajectory } from "../../src/features/conversation/trajectory/useTrajectory.ts";
import { click, mount } from "../helpers/mount.ts";

function Probe() {
	const state = useTrajectory();
	return h("div", null, h("span", null, `${state.loading}:${state.error}:${state.all.map(entry => entry.detail).join(",")}`), h("button", { onClick: state.refresh }, "refresh"));
}

test("durable events during a read are drained once; old-session responses cannot replace the new session and errors are visible", async () => {
	const requests: { id: string; resolve: (changes: TrajectoryChanges) => void; reject: (error: Error) => void }[] = [];
	const listeners = new Set<(payload: { sessionId: string; event: AgentEvent }) => void>();
	const meta: SessionMeta = { id: "trace-refresh-a", projectId: "p", projectName: "QA", cwd: "/tmp", title: "A", createdAt: 1, updatedAt: 1, messageCount: 1, seq: 1, modelId: "qa", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	Object.defineProperty(window, "plume", { configurable: true, value: {
		sessions: { trajectoryChanges: (id: string) => new Promise<TrajectoryChanges>((resolve, reject) => requests.push({ id, resolve, reject })) },
		agent: { onEvent: (listener: (payload: { sessionId: string; event: AgentEvent }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
	} });
	useApp.setState({ meta });
	const view = await mount(h(Probe));
	const entry = (detail: string): Entry => ({ seq: 1, ts: 1, source: "compaction", detail, summary: detail });
	const changes = (detail: string): TrajectoryChanges => ({ cursor: detail, reset: true, upserts: [entry(detail)], removals: [] });
	try {
		assert.equal(requests.length, 1);
		await act(async () => { for (let i = 0; i < 10; i++) for (const listener of listeners) listener({ sessionId: meta.id, event: { type: "compacted", before: 20, after: 8 } }); });
		assert.equal(requests.length, 1, "only one read may be in flight");
		await act(async () => requests[0].resolve(changes("A")));
		assert.equal(requests.length, 2, "a committed change during the read must be fetched");
		await act(async () => useApp.setState({ meta: { ...meta, id: "trace-refresh-b" } }));
		assert.equal(requests.length, 3);
		assert.ok(!view.text().includes(":A"));
		await act(async () => requests[1].resolve(changes("stale A")));
		assert.ok(!view.text().includes("stale A"));
		await act(async () => requests[2].reject(new Error("disk failure")));
		assert.match(view.text(), /disk failure/);
		await click(view.find("button"));
		await act(async () => requests[3].resolve(changes("B")));
		assert.match(view.text(), /false::B/);
	} finally {
		await view.unmount();
		assert.equal(listeners.size, 0);
		if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume");
	}
});

test("reconnect and foreground recovery share the incremental read drain and remove their listeners on unmount", async () => {
	const requests: { cursor?: string; resolve: (changes: TrajectoryChanges) => void }[] = [];
	const listeners = new Set<(payload: { sessionId: string; event: AgentEvent }) => void>();
	const meta: SessionMeta = { id: "trace-reconnect", projectId: "p", projectName: "QA", cwd: "/tmp", title: "Reconnect", createdAt: 1, updatedAt: 1, messageCount: 1, seq: 1, modelId: "qa", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	Object.defineProperty(window, "plume", { configurable: true, value: {
		sessions: { trajectoryChanges: (_id: string, cursor?: string) => new Promise<TrajectoryChanges>(resolve => requests.push({ cursor, resolve })) },
		agent: { onEvent: (listener: (payload: { sessionId: string; event: AgentEvent }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
	} });
	useApp.setState({ meta });
	const view = await mount(h(Probe));
	const entry = (seq: number, detail: string): Entry => ({ seq, ts: seq, source: "compaction", detail, summary: detail });
	const connection = (detail: string) => window.dispatchEvent(new CustomEvent("plume:connection", { detail }));
	try {
		assert.equal(requests.length, 1);
		assert.equal(requests[0].cursor, undefined);
		await act(async () => requests[0].resolve({ cursor: "epoch:1", reset: true, upserts: [entry(1, "before disconnect")], removals: [] }));
		await act(async () => {
			connection("reconnecting");
			useApp.setState({ meta: { ...meta, seq: 2, updatedAt: 2 } });
		});
		assert.equal(requests.length, 1, "metadata updates must not start a duplicate trajectory read");
		await act(async () => connection("connected"));
		assert.equal(requests.length, 2, "a connection recovery must fetch changes missed while offline");
		assert.equal(requests[1].cursor, "epoch:1");
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
			document.dispatchEvent(new Event("visibilitychange"));
			connection("connected");
		});
		assert.equal(requests.length, 2, "recovery events must join the existing in-flight read");
		await act(async () => requests[1].resolve({ cursor: "epoch:2", reset: false, upserts: [entry(1, "after reconnect"), entry(2, "missed event")], removals: [] }));
		assert.equal(requests.length, 3, "the recovery burst must drain in one follow-up read");
		assert.equal(requests[2].cursor, "epoch:2");
		await act(async () => requests[2].resolve({ cursor: "epoch:2", reset: false, upserts: [], removals: [] }));
		assert.match(view.text(), /false::after reconnect,missed event/);
		assert.ok(!view.text().includes("before disconnect"));

		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
			window.dispatchEvent(new Event("focus"));
			connection("offline");
		});
		assert.equal(requests.length, 3, "backgrounding and disconnecting do not issue reads");
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		assert.equal(requests.length, 4);
		await act(async () => requests[3].resolve({ cursor: "epoch:3", reset: false, upserts: [entry(3, "visible again")], removals: [] }));
		assert.match(view.text(), /after reconnect,missed event,visible again/);
		await act(async () => window.dispatchEvent(new Event("focus")));
		assert.equal(requests.length, 5);
		assert.equal(requests[4].cursor, "epoch:3");
		await act(async () => requests[4].resolve({ cursor: "epoch:4", reset: false, upserts: [entry(4, "focused again")], removals: [] }));
		assert.match(view.text(), /visible again,focused again/);
	} finally {
		await view.unmount();
		const finished = requests.length;
		await act(async () => {
			connection("connected");
			window.dispatchEvent(new Event("focus"));
			document.dispatchEvent(new Event("visibilitychange"));
		});
		assert.equal(requests.length, finished, "unmounted panels must not retain recovery listeners");
		assert.equal(listeners.size, 0);
		if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility); else Reflect.deleteProperty(document, "visibilityState");
		if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume");
	}
});
