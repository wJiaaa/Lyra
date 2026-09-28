import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, useState } from "react";
import type { Entry } from "@plume/core/trajectory-view";
import { TraceInspector } from "../../src/features/conversation/trajectory/TraceInspector.tsx";
import { click, mount } from "../helpers/mount.ts";

const first: Entry = { id: "first", seq: 1, ts: 0, source: "request", summary: "第一条记录", detail: "完整正文" };
const second: Entry = { ...first, id: "second", seq: 2, summary: "关联记录" };

function fixture() {
	const toolbar = document.createElement("div");
	const fallback = document.createElement("button"); fallback.textContent = "时间概览";
	toolbar.append(fallback); document.body.append(toolbar);
	const opener = document.createElement("button"); opener.textContent = "轨迹记录"; document.body.append(opener); opener.focus();
	const props = { anchor: toolbar, all: [first, second], query: "", onSelect: () => {}, onClose: () => {}, onExport: () => {}, onOutput: () => {}, onFork: () => {} };
	return { toolbar, fallback, opener, props, remove: () => { toolbar.remove(); opener.remove(); } };
}

function header() {
	const element = document.querySelector<HTMLElement>("[data-trace-inspector-header]"); assert.ok(element); return element;
}

test("inspector focus starts before its actions and explicit close restores the opening record", async () => {
	const state = fixture();
	function Controlled() {
		const [open, setOpen] = useState(true);
		return open ? h(TraceInspector, { ...state.props, entry: first, onClose: () => setOpen(false) }) : null;
	}
	const view = await mount(h(Controlled));
	try {
		const title = header();
		assert.ok(document.activeElement === title);
		assert.equal(title.tabIndex, -1); assert.equal(title.getAttribute("role"), "group");
		const actions = [...title.querySelectorAll<HTMLButtonElement>("button")];
		assert.ok(actions.length >= 2 && actions.every(button => button.tabIndex === 0));
		actions[0].focus(); assert.ok(document.activeElement === actions[0]);
		const close = title.querySelector('[aria-label="返回记录"]'); assert.ok(close); await click(close);
		assert.equal(document.querySelector(".ly-trace-inspector"), null);
		assert.ok(document.activeElement === state.opener);
	} finally { await view.unmount(); state.remove(); }
});

test("switching entries retains the header, active tab and original return target", async () => {
	const state = fixture();
	const view = await mount(h(TraceInspector, { ...state.props, entry: first }));
	try {
		const original = header();
		await view.rerender(h(TraceInspector, { ...state.props, entry: second }));
		assert.ok(header() === original && document.activeElement === header());
		assert.ok(view.text().includes(second.summary));
		await view.rerender(null);
		assert.ok(document.activeElement === state.opener);
	} finally { await view.unmount(); state.remove(); }
});

test("a virtualized opener that disappeared returns to the stable toolbar", async () => {
	const state = fixture();
	const view = await mount(h(TraceInspector, { ...state.props, entry: first }));
	try {
		state.opener.remove();
		await view.rerender(null);
		assert.ok(document.activeElement === state.fallback);
	} finally { await view.unmount(); state.remove(); }
});

test("closing never steals focus from a new external control", async () => {
	const state = fixture();
	const external = document.createElement("input"); document.body.append(external);
	const view = await mount(h(TraceInspector, { ...state.props, entry: first }));
	try {
		external.focus(); await view.rerender(null);
		assert.ok(document.activeElement === external);
	} finally { await view.unmount(); external.remove(); state.remove(); }
});

test("focus released to the document still returns to the opener when the inspector closes", async () => {
	const state = fixture();
	const view = await mount(h(TraceInspector, { ...state.props, entry: first }));
	try {
		header().blur(); assert.ok(document.activeElement === document.body);
		await view.rerender(null);
		assert.ok(document.activeElement === state.opener);
	} finally { await view.unmount(); state.remove(); }
});
