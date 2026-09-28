import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;
before(async () => { app = await startApp({ port: 9642 }); });
after(async () => { await app?.stop(); });

test("evaluations retain pending promises through GC and release their handles after settling", async () => {
	// Match V8 bug 536271637: the protocol must own the only strong reference while awaiting.
	for (const rejects of [false, true]) {
		const pending = app.evaluate<number>(`(() => {
			let settle;
			const promise = new Promise((resolve, reject) => settle = ${rejects ? "reject" : "resolve"});
			promise.settle = settle;
			globalThis.__plumePromiseProbe = new WeakRef(promise);
			return promise;
		})()`).then(value => ({ value }), error => ({ error: String(error) }));
		try {
			for (let i = 0; i < 100; i++) {
				if (await app.evaluate<boolean>("Boolean(globalThis.__plumePromiseProbe)")) break;
				assert.ok(i < 99, "the pending evaluation reached the renderer");
			}
			await app.send("HeapProfiler.collectGarbage");
			await app.evaluate("globalThis.__plumePromiseProbe.deref()?.settle(42)");
			const result = await pending;
			if (rejects) {
				assert.ok("error" in result);
				assert.match(result.error, /Uncaught/);
			} else assert.deepEqual(result, { value: 42 });
			await app.send("HeapProfiler.collectGarbage");
			assert.equal(await app.evaluate("globalThis.__plumePromiseProbe.deref() === undefined"), true);
		} finally {
			await app.evaluate("delete globalThis.__plumePromiseProbe");
		}
	}
});

test("evaluations preserve statement results, serializable values and exceptions", async () => {
	assert.equal(await app.evaluate("1 + 2"), 3);
	assert.equal(await app.evaluate("document.body.dataset.cdpProbe = 'ready'; document.body.dataset.cdpProbe"), "ready");
	assert.equal(await app.evaluate("undefined"), undefined);
	assert.equal(await app.evaluate("null"), null);
	assert.deepEqual(await app.evaluate("({ items: [1, 'two', false], nested: { ready: true } })"), { items: [1, "two", false], nested: { ready: true } });
	assert.deepEqual(await app.evaluate("Promise.resolve({ ready: true })"), { ready: true });
	assert.deepEqual(await app.evaluate("({ then(resolve) { resolve({ ready: true }); } })"), { ready: true });
	await assert.rejects(app.evaluate("throw new Error('sync probe')"), /Uncaught/);
	await assert.rejects(app.evaluate("Promise.reject(new Error('async probe'))"), /Uncaught/);
	await app.evaluate("delete document.body.dataset.cdpProbe");
});

test("serialization failures release the remote result", async () => {
	try {
		await assert.rejects(app.evaluate(`(() => {
			const value = {};
			value.self = value;
			globalThis.__plumeObjectProbe = new WeakRef(value);
			return value;
		})()`), /Object reference chain|returned by value/);
		await app.send("HeapProfiler.collectGarbage");
		assert.equal(await app.evaluate("globalThis.__plumeObjectProbe.deref() === undefined"), true);
	} finally {
		await app.evaluate("delete globalThis.__plumeObjectProbe");
	}
});
