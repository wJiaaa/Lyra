/**
 * What the card takes from a page's design controls (`plume.tweak`), and what it will send back.
 *
 * The page is the agent's code: these are the rules that keep a malformed control out of the panel and
 * a value the control cannot take out of the page. The round trip itself is in the real window
 * (`e2e/preview-page-tools-demo.ts`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TWEAK_CONTROLS, readTweaks, tweakValue, TWEAKS_MESSAGE, type TweakControl } from "../shared/preview.ts";

const offer = (groups: unknown) => readTweaks({ [TWEAKS_MESSAGE]: groups });

test("the four kinds come through, with their values", () => {
	const groups = offer([{
		label: "播放器",
		controls: [
			{ id: "0.0", kind: "slider", label: "圆角", value: 18, min: 0, max: 40, unit: "px" },
			{ id: "0.1", kind: "color", label: "主色", value: "#7C3AED" },
			{ id: "0.2", kind: "toggle", label: "播放中", value: true },
			{ id: "0.3", kind: "select", label: "密度", value: "compact", options: ["normal", { label: "紧凑", value: "compact" }] },
		],
	}]);
	assert.equal(groups?.length, 1);
	const [slider, color, toggle, select] = groups![0]!.controls;
	assert.deepEqual(slider, { id: "0.0", label: "圆角", value: 18, kind: "slider", min: 0, max: 40, step: 1, unit: "px" });
	assert.equal(color?.value, "#7c3aed");
	assert.equal(toggle?.value, true);
	assert.deepEqual(select?.kind === "select" && select.options, [{ label: "normal", value: "normal" }, { label: "紧凑", value: "compact" }]);
});

test("a control that cannot be drawn is left out, and a group left empty with it", () => {
	const groups = offer([
		{ label: "a", controls: [
			{ id: "1", kind: "knob", value: 1 },
			{ id: "2", kind: "slider", value: 5, min: 10, max: 0 },
			{ id: "3", kind: "color", value: "red" },
			{ id: "4", kind: "select", value: "x", options: [] },
			{ kind: "toggle", value: true },
			{ id: "6", kind: "toggle", value: true },
		] },
		{ label: "b", controls: [{ id: "7", kind: "toggle", value: "yes" }] },
	]);
	assert.deepEqual(groups?.map((group) => group.controls.map((control) => control.id)), [["6"]]);
});

test("not a list of controls is not an offer", () => {
	assert.equal(readTweaks({}), null);
	assert.equal(readTweaks(null), null);
	assert.equal(offer("x"), null);
});

test("a page offers at most so many controls a group", () => {
	const controls = Array.from({ length: 20 }, (_, i) => ({ id: String(i), kind: "toggle", value: false }));
	assert.equal(offer([{ controls }])?.[0]?.controls.length, MAX_TWEAK_CONTROLS);
});

test("a value sent to the page is one its control can take", () => {
	const slider: TweakControl = { id: "s", label: "", value: 0, kind: "slider", min: 0, max: 40, step: 4, unit: "px" };
	assert.equal(tweakValue(slider, 9), 8, "onto a step");
	assert.equal(tweakValue(slider, 99), 40, "inside the range");
	assert.equal(tweakValue(slider, "12"), null);
	const select: TweakControl = { id: "c", label: "", value: "a", kind: "select", options: [{ label: "A", value: "a" }] };
	assert.equal(tweakValue(select, "b"), null);
	assert.equal(tweakValue({ id: "t", label: "", value: false, kind: "toggle" }, 1), null);
});
