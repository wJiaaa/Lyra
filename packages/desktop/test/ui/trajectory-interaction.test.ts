import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createElement as h, useState, type ComponentProps } from "react";
import { entryKey, type Entry } from "@plume/core/trajectory-view";
import { TraceTimeline } from "../../src/features/conversation/trajectory/TraceTimeline.tsx";
import { click, fire, mount, press } from "../helpers/mount.ts";

const entry: Entry = { id: "request", seq: 1, ts: 0, source: "request", summary: "模型请求", detail: "", startedAt: 0, finishedAt: 1000 };
const second: Entry = { ...entry, id: "tool", seq: 2, source: "tool-call", startedAt: 500 };
const third: Entry = { ...entry, id: "compact", seq: 3, source: "compaction", startedAt: 800 };

function replace(t: TestContext, target: object, key: PropertyKey, value: unknown) {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, value });
	t.after(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
}

async function timeline(t: TestContext, props: Partial<ComponentProps<typeof TraceTimeline>> = {}, paint: { dpr?: number; context?: object } = {}) {
	replace(t, globalThis, "devicePixelRatio", paint.dpr ?? 1);
	replace(t, window.HTMLCanvasElement.prototype, "clientWidth", 100);
	replace(t, window.HTMLCanvasElement.prototype, "getBoundingClientRect", () => new window.DOMRect(0, 0, 100, 48));
	replace(t, window.HTMLCanvasElement.prototype, "getContext", () => paint.context ?? null);
	replace(t, window.HTMLCanvasElement.prototype, "setPointerCapture", () => {});
	const ranges: unknown[] = [], selected: Entry[] = [];
	const view = await mount(h(TraceTimeline, { entries: [entry], range: null, selected: null, onRange: value => { ranges.push(value); }, onSelect: value => { selected.push(value); }, ...props }));
	t.after(() => view.unmount());
	const toggle = () => click(view.find('button[aria-label="时间概览"]'));
	return { view, toggle, ranges, selected };
}

function canvas() {
	const element = document.querySelector<HTMLCanvasElement>("[data-trace-timeline] canvas");
	assert.ok(element); return element;
}

const pointer = (type: string, x: number) => fire(canvas(), new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 8 }));

test("inline selection preserves its canvas; brush commits once and cancellation leaves the ledger alone", async t => {
	const { ranges, selected, toggle } = await timeline(t);
	const original = canvas();
	await pointer("pointerdown", 50); await pointer("pointermove", 51); await pointer("pointerup", 51);
	assert.deepEqual(ranges, []); assert.deepEqual(selected, [entry]); assert.equal(canvas(), original);
	await pointer("pointerdown", 25); await pointer("pointermove", 50);
	assert.deepEqual(ranges, []);
	await pointer("pointerup", 75); assert.deepEqual(ranges, [{ start: 250, end: 750 }]);
	await pointer("pointerdown", 20); await pointer("pointermove", 60); await pointer("pointercancel", 60); await pointer("pointerup", 60);
	assert.equal(ranges.length, 1);
	await toggle(); await toggle(); assert.equal(canvas(), original, "collapsing preserves the canvas node");
});

test("Escape cancels an unfinished brush and whitespace never chooses another lane", async t => {
	const { ranges, selected } = await timeline(t);
	await pointer("pointerdown", 20); await pointer("pointermove", 60); await press(canvas(), "Escape");
	assert.deepEqual(ranges, [null]);
	await pointer("pointermove", 80); await pointer("pointerup", 90); assert.deepEqual(selected, []);
	await fire(canvas(), new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 50, clientY: 40 }));
	await fire(canvas(), new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 50, clientY: 40 }));
	assert.deepEqual(selected, []); assert.ok(canvas());
});

test("keyboard previews and zoom stay local; controls retain identity across selection and reset", async t => {
	const selected: Entry[] = [], ranges: unknown[] = [];
	function Controlled() {
		const [range, setRange] = useState<{ start: number; end: number } | null>(null);
		const [key, setKey] = useState(entryKey(entry));
		return h(TraceTimeline, { entries: [entry, second, third], range, selected: key,
			onRange: next => { ranges.push(next); setRange(next); }, onSelect: next => { selected.push(next); setKey(entryKey(next)); } });
	}
	const { view } = await timeline(t); await view.rerender(h(Controlled));
	const zoom = view.find('button[aria-label="放大时间范围"]');
	const reset = view.find('button[aria-label="重置时间范围"]');
	await click(zoom); await press(canvas(), "ArrowRight"); assert.equal(canvas().getAttribute("aria-valuenow"), "1");
	const described = canvas().getAttribute("aria-valuetext"); await pointer("pointermove", 20);
	assert.equal(canvas().getAttribute("aria-valuetext"), described);
	await press(canvas(), "End"); assert.equal(canvas().getAttribute("aria-valuenow"), "2");
	await press(canvas(), "Enter", { repeat: true }); assert.deepEqual(selected, []);
	await press(canvas(), "Enter"); assert.deepEqual(selected, [third]); assert.deepEqual(ranges, []);
	assert.ok(view.find('button[aria-label="放大时间范围"]') === zoom);
	assert.ok(view.find('button[aria-label="重置时间范围"]') === reset);
	await click(reset); assert.deepEqual(ranges, [null]);
	assert.equal(view.find<HTMLInputElement>('[aria-label="平移时间视口"]').disabled, true);
});

test("opening and reopening paint the current theme at device resolution and detach the old painter", async t => {
	const paints: string[] = [], scales: number[] = [];
	const context = { fillStyle: "", globalAlpha: 1,
		scale: (x: number) => { scales.push(x); },
		fillRect: () => { paints.push(context.fillStyle); }, strokeRect: () => {},
	};
	const observers = new Set<() => void>();
	const computed = getComputedStyle;
	// Custom-property inheritance also belongs to the browser, not this DOM shim.
	replace(t, globalThis, "getComputedStyle", (element: Element) => {
		const style = computed(element);
		if (element.tagName === "CANVAS") {
			const read = style.getPropertyValue.bind(style);
			Object.defineProperty(style, "getPropertyValue", { configurable: true, value: (property: string) => property.startsWith("--color-") ? document.documentElement.style.getPropertyValue(property) : read(property) });
		}
		return style;
	});
	// Happy DOM has no compositor; invoke the registered root theme observer explicitly.
	replace(t, globalThis, "MutationObserver", class {
		callback: () => void;
		constructor(callback: () => void) { this.callback = callback; }
		observe(target: Node) { if (target === document.documentElement) observers.add(this.callback); }
		disconnect() { observers.delete(this.callback); }
		takeRecords() { return []; }
	});
	const previous = document.documentElement.style.getPropertyValue("--color-info");
	t.after(() => { if (previous) document.documentElement.style.setProperty("--color-info", previous); else document.documentElement.style.removeProperty("--color-info"); });
	document.documentElement.style.setProperty("--color-info", "rgb(10, 20, 30)");
	const { toggle } = await timeline(t, {}, { dpr: 2, context });
	assert.ok(paints.length > 0);
	assert.equal(canvas().width, 200); assert.equal(canvas().height, 96);
	assert.equal(paints.at(-1), "rgb(10, 20, 30)"); assert.ok(scales.every(value => value === 2));
	document.documentElement.style.setProperty("--color-info", "rgb(40, 50, 60)");
	for (const paint of observers) paint();
	assert.equal(paints.at(-1), "rgb(40, 50, 60)");
	await toggle(); assert.equal(observers.size, 0, "closing detaches the old canvas theme observer");
	const closedCount = paints.length;
	document.documentElement.style.setProperty("--color-info", "rgb(70, 80, 90)");
	for (const paint of observers) paint();
	assert.equal(paints.length, closedCount);
	await toggle(); assert.equal(paints.at(-1), "rgb(70, 80, 90)"); assert.equal(observers.size, 1);
});
