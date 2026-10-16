import assert from "node:assert/strict";
import { test } from "node:test";

// 帧由测试自己推：`inFrame` 排进去的东西只在这里调 `tick()` 时落地。
let frames: Array<() => void> = [];
const tick = () => {
	const due = frames;
	frames = [];
	for (const run of due) run();
};
const reported: unknown[] = [];
let reply: (value: string) => void = () => {};
const scope = globalThis as Record<string, unknown>;
scope.requestAnimationFrame = (run: () => void) => frames.push(run);
scope.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
scope.reportError = (error: unknown) => reported.push(error);
scope.document = { visibilityState: "visible", addEventListener() {} };
scope.window = {
	addEventListener() {},
	plume: { sessions: { read: () => new Promise<string>((resolve) => { reply = resolve; }) } },
};
const { inFrame, flushPushes } = await import("../src/services/pushes.ts");
const { bridge } = await import("../src/services/bridge.ts");

test("pushes that arrive before a frame are applied together, in arrival order", () => {
	const seen: string[] = [];
	inFrame(() => seen.push("message_start"));
	inFrame(() => seen.push("message_end"));
	inFrame(() => seen.push("agent_start"));
	assert.deepEqual(seen, []);
	assert.equal(frames.length, 1, "one frame for the whole burst");
	tick();
	assert.deepEqual(seen, ["message_start", "message_end", "agent_start"]);
});

test("a reply resolves only after the pushes that arrived ahead of it", async () => {
	const seen: string[] = [];
	const read = bridge.sessions.read("a" as never).then(() => seen.push("reply"));
	inFrame(() => seen.push("message_start"));
	reply("transcript");
	await read;
	assert.deepEqual(seen, ["message_start", "reply"]);
	tick();
	assert.deepEqual(seen, ["message_start", "reply"], "already applied, not applied again");
});

test("a hidden window applies pushes at once, behind anything already queued", () => {
	const seen: string[] = [];
	inFrame(() => seen.push("queued"));
	(scope.document as { visibilityState: string }).visibilityState = "hidden";
	try {
		inFrame(() => seen.push("hidden"));
		assert.deepEqual(seen, ["queued", "hidden"]);
	} finally {
		(scope.document as { visibilityState: string }).visibilityState = "visible";
	}
	tick();
});

test("one push throwing does not drop the ones behind it", () => {
	const seen: string[] = [];
	inFrame(() => { throw new Error("bad event"); });
	inFrame(() => seen.push("next"));
	flushPushes();
	assert.deepEqual(seen, ["next"]);
	assert.equal((reported.at(-1) as Error).message, "bad event");
});
