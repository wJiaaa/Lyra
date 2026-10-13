/**
 * While a block is written, each element that arrives is uncovered from the top down where its
 * placeholder stood: a line runs down it, what is above the line is the element, what is below is
 * still dots. Arriving whole at the same instant everywhere read as a switch being flipped; this reads
 * as the element being laid down in the direction it was written. A chart or a table is first traced
 * in dotted lines (`trace.ts`); anything else is only uncovered.
 *
 * Done on the DOM rather than in each component. Wrapping an element to carry the animation makes
 * the wrapper the child of its row or grid — `.ly-ui-row > [data-ly-ui-field]` stops matching — and
 * the wrapper would have to stay once written, or every element would remount when writing ends.
 * The dots and the line go in a layer beside the drawing, which React renders empty and never reconciles.
 */

import { useEffect, type RefObject } from "react";
import { motionReduced } from "../../../ui/motion/reduced.ts";
import { DURATION, EASING } from "../../../ui/motion/tokens.ts";
import { trace } from "./trace.ts";

/**
 * Which arrivals are traced, by the placeholder they took over from. Not by size: a card that arrived
 * with its first rows was tall enough, and tracing it hid everything written into it afterwards until
 * the line reached it. A container never has a placeholder (`render.tsx`), so is never traced; the
 * rest are small enough that a drawing of their parts is a few dots in a row.
 */
const TRACED = new Set(["Chart", "Table"]);

/**
 * Taller takes longer, so the line moves at much the same speed down a button and down a chart: a
 * fixed duration made a 30px row crawl and a 500px card flash past.
 */
function durationFor(height: number): number {
	return Math.round(Math.min(DURATION.slow * 2, DURATION.base + height * 0.8));
}

function uncover(node: HTMLElement, layer: HTMLElement): void {
	const origin = layer.getBoundingClientRect();
	const box = node.getBoundingClientRect();
	const timing = { duration: durationFor(box.height), easing: EASING.out };
	node.animate([{ clipPath: "inset(0 0 100% 0)", filter: "blur(2px)" }, { clipPath: "inset(0 0 0 0)", filter: "blur(0)" }], timing);
	if (!box.width || !box.height) return;
	const place = (element: HTMLElement, height: number) =>
		Object.assign(element.style, { left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${height}px` });

	const dots = document.createElement("div");
	dots.className = "ly-ui-fade";
	place(dots, box.height);
	dots.style.borderRadius = getComputedStyle(node).borderRadius;
	const line = document.createElement("div");
	line.className = "ly-ui-scan";
	place(line, 1);
	layer.append(dots, line);
	const gone = (element: HTMLElement) => () => element.remove();
	dots.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(100% 0 0 0)" }], { ...timing, fill: "forwards" }).finished.then(gone(dots), gone(dots));
	/*
	 * The line rides the same curve as the edge it marks, and moves by `top`, not `transform`: a
	 * transform runs on the compositor while the clip it follows runs on the main thread, and on screen
	 * the line ran a dozen pixels ahead of the edge although their computed values agreed.
	 */
	const top = box.top - origin.top;
	line.animate([{ top: `${top}px` }, { top: `${top + box.height}px` }], { ...timing, fill: "forwards" }).finished.then(gone(line), gone(line));
	line.animate([{ opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: timing.duration, fill: "forwards" });
}

export function useArrivals(drawing: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, active: boolean): void {
	useEffect(() => {
		const root = drawing.current;
		const effects = layer.current;
		if (!active || !root || !effects) return;
		// A microtask after React's commit, so before the frame that would show the element uncovered.
		const observer = new MutationObserver((records) => {
			if (motionReduced()) return;
			// The placeholder leaves its parent in the same commit its element arrives there.
			const handed = new Map<Node, string>();
			for (const record of records) {
				for (const node of record.removedNodes) if (node instanceof HTMLElement && node.dataset.lyUiPending) handed.set(record.target, node.dataset.lyUiPending);
			}
			for (const record of records) {
				for (const node of record.addedNodes) {
					// Only the outermost element that arrived: what arrived with it is inside and is uncovered with it.
					// SVG drawn later inside a chart, and text growing in a line, are not arrivals.
					if (!(node instanceof HTMLElement) || node.classList.contains("ly-ui-pending")) continue;
					if (TRACED.has(handed.get(record.target) ?? "")) trace(node, effects);
					else uncover(node, effects);
				}
			}
		});
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [drawing, layer, active]);
}
