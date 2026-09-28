import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Activity, act, createElement as h } from "react";
import type { WorkflowRunSummary } from "../../electron/ipc-types.ts";
import { PipelinesView } from "../../src/features/git/PipelinesView.tsx";
import { writeCachedRuns } from "../../src/features/git/pipeline-cache.ts";
import { click, mount } from "../helpers/mount.ts";

const cwd = "/fixture/pipelines";
interface PendingRequest {
	resolve(runs: WorkflowRunSummary[]): void;
	reject(cause: unknown): void;
}
function fixture(t: TestContext) {
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
	localStorage.clear();
	const pending: PendingRequest[] = [];
	Object.defineProperty(window, "plume", { configurable: true, value: { git: {
		listWorkflowRuns: () => new Promise<WorkflowRunSummary[]>((resolve, reject) => pending.push({ resolve, reject })),
	} } });
	t.after(() => {
		localStorage.clear();
		if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume");
	});
	return pending;
}
const run = (name: string): WorkflowRunSummary => ({ id: 1, name, displayTitle: name, event: "push", status: "completed", conclusion: "success", headBranch: "main", headSha: "1234567", createdAt: "2026-09-07T00:00:00Z", url: "https://example.com/run/1" });

test("a cold pipeline load never paints an empty run-list header before its response", async t => {
	const pending = fixture(t);
	const view = await mount(h(PipelinesView, { cwd }));
	try {
		assert.doesNotMatch(view.text(), /CI \/ CD|暂无/);
		assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, true);
		await act(async () => pending[0].resolve([]));
		assert.match(view.text(), /暂无.*记录/);
		assert.equal(pending.length, 1);
	} finally { await view.unmount(); }
});

test("a cached empty result stays visible during refresh and Activity reactivation", async t => {
	const pending = fixture(t);
	writeCachedRuns(cwd, []);
	const page = (visible: boolean) => h(Activity, { mode: visible ? "visible" : "hidden", children: h(PipelinesView, { cwd }) });
	const view = await mount(page(true));
	try {
		assert.match(view.text(), /暂无.*记录/);
		await act(async () => pending[0].resolve([]));
		await view.rerender(page(false));
		await view.rerender(page(true));
		assert.match(view.text(), /暂无.*记录/);
		assert.doesNotMatch(view.text(), /CI \/ CD/);
		assert.equal(pending.length, 2);
	} finally { await view.unmount(); }
});

test("a resumed pipeline request owns the displayed result and cache", async t => {
	const pending = fixture(t);
	writeCachedRuns(cwd, [run("cached")]);
	const page = (visible: boolean) => h(Activity, { mode: visible ? "visible" : "hidden", children: h(PipelinesView, { cwd }) });
	const view = await mount(page(true));
	try {
		await view.rerender(page(false));
		await view.rerender(page(true));
		await act(async () => pending[1].resolve([run("latest")]));
		await act(async () => pending[0].resolve([run("stale")]));
		assert.match(view.text(), /latest/);
		assert.doesNotMatch(view.text(), /stale/);
		assert.match(localStorage.getItem(`plume.pipelines.runs.v1:${cwd}`) ?? "", /latest/);
	} finally { await view.unmount(); }
});

test("a changed pipeline result does not launch a second initial request", async t => {
	const pending = fixture(t);
	const view = await mount(h(PipelinesView, { cwd }));
	try {
		await act(async () => pending[0].resolve([run("loaded")]));
		assert.match(view.text(), /loaded/);
		assert.equal(pending.length, 1);
	} finally { await view.unmount(); }
});

test("polling lets a slow in-flight response finish instead of continually superseding it", async t => {
	const pending = fixture(t);
	writeCachedRuns(cwd, [{ ...run("running"), status: "in_progress", conclusion: null }]);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const view = await mount(h(PipelinesView, { cwd }));
	try {
		await act(async () => t.mock.timers.tick(7_000));
		assert.equal(pending.length, 1);
		await act(async () => pending[0].resolve([run("finished")]));
		assert.match(view.text(), /finished/);
	} finally { await view.unmount(); }
});

test("a failed cold load shows its error and can retry without claiming an empty result", async t => {
	const pending = fixture(t);
	const view = await mount(h(PipelinesView, { cwd }));
	try {
		await act(async () => pending[0].reject(new Error("Pipeline request failed")));
		assert.match(view.text(), /无法读取流水线/);
		assert.equal(view.find('[role="alert"]').textContent, "Pipeline request failed");
		assert.doesNotMatch(view.text(), /暂无/);
		assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
		assert.equal(localStorage.getItem(`plume.pipelines.runs.v1:${cwd}`), null);
		const refresh = view.find<HTMLButtonElement>('[aria-label="刷新流水线"]');
		assert.equal(refresh.disabled, false);
		await click(refresh);
		assert.equal(pending.length, 2);
		assert.equal(view.host.querySelector('[role="alert"]'), null);
		assert.ok(view.host.querySelector('[aria-busy="true"]'));
		await act(async () => pending[1].resolve([run("recovered")]));
		assert.match(view.text(), /recovered/);
		assert.equal(view.host.querySelector('[role="alert"]'), null);
		assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, false);
	} finally { await view.unmount(); }
});

test("a failed refresh preserves the displayed runs and their cache", async t => {
	const pending = fixture(t);
	const view = await mount(h(PipelinesView, { cwd }));
	try {
		const loaded = [run("loaded")];
		await act(async () => pending[0].resolve(loaded));
		await click(view.find('[aria-label="刷新流水线"]'));
		assert.equal(pending.length, 2);
		assert.match(view.text(), /loaded/);
		assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, true);
		await act(async () => pending[1].reject(new Error("Refresh failed")));
		assert.equal(view.find('[role="alert"]').textContent, "Refresh failed");
		assert.match(view.text(), /loaded/);
		assert.doesNotMatch(view.text(), /暂无/);
		assert.equal(localStorage.getItem(`plume.pipelines.runs.v1:${cwd}`), JSON.stringify(loaded));
		assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, false);
	} finally { await view.unmount(); }
});

for (const outcome of ["resolve", "reject"]) {
	test(`an obsolete request that ${outcome}s cannot unlock a pending request after Activity resumes`, async t => {
		const pending = fixture(t);
		const cached: WorkflowRunSummary[] = [{ ...run("running"), status: "in_progress", conclusion: null }];
		writeCachedRuns(cwd, cached);
		t.mock.timers.enable({ apis: ["setInterval"] });
		const page = (visible: boolean) => h(Activity, { mode: visible ? "visible" : "hidden", children: h(PipelinesView, { cwd }) });
		const view = await mount(page(true));
		try {
			await view.rerender(page(false));
			await view.rerender(page(true));
			assert.equal(pending.length, 2);
			await act(async () => {
				if (outcome === "resolve") pending[0].resolve([run("stale")]);
				else pending[0].reject(new Error("Obsolete request failed"));
			});
			assert.match(view.text(), /running/);
			assert.doesNotMatch(view.text(), /stale|Obsolete request failed/);
			assert.equal(view.host.querySelector('[role="alert"]'), null);
			assert.equal(localStorage.getItem(`plume.pipelines.runs.v1:${cwd}`), JSON.stringify(cached));
			assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, true);
			await act(async () => t.mock.timers.tick(7_000));
			assert.equal(pending.length, 2, "polling must not replace the request that still owns the visible view");
			await act(async () => pending[1].resolve([run("latest")]));
			assert.match(view.text(), /latest/);
			assert.equal(view.find<HTMLButtonElement>('[aria-label="刷新流水线"]').disabled, false);
		} finally { await view.unmount(); }
	});
}
