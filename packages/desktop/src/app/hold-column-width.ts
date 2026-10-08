/**
 * The conversation column's width, held at where the sidebar is going for the length of its slide.
 *
 * The column's width follows its pane's with a flat stretch in it (`--ly-content` in `dock.css`):
 * between 992px and 1280px of pane it stays at 864px. A sliding sidebar sweeps the pane across that
 * stretch, so one click used to read as two motions — at 1440px, 60ms of the column only moving at
 * 864px wide, then 140ms of it widening to 970px and rewrapping as the pane passed 1280px.
 *
 * Held at its destination, the column takes its final width on the first frame and the slide is the
 * only motion left. The destination is measured rather than computed: a probe as wide as the pane
 * will be resolves `--ly-content` through the same container queries, so the breakpoints stay
 * written in one place.
 *
 * The held value is an expression, not a number, because every column under the variable has a
 * gutter of its own — the transcript's and the composer's differ by 32px — and a number is one
 * width for all of them. `100% - 100cqw` is minus that gutter wherever the expression lands, so
 * `box(P)` below is each column's own room at a pane width P.
 *
 * A column that does not fit at its destination width yet — the sidebar closing beside a narrow pane
 * — cannot take it on the first frame. It grows in step with the pane instead, start to finish:
 * held at the room it has, it would grow until it fit and then only slide, the same two motions.
 */

/** Longer than `--ly-t-base`: the release normally comes from `transitionend`, this is in case it does not. */
const FALLBACK_MS = 400;

/**
 * Hold every pane's column at its destination width, and hand back the release.
 *
 * `frame` is the sidebar's frame — the element whose `margin-left` slides — already rendered with
 * its destination style; `navAfter` is how much of the row it will take once settled. Its computed
 * margin is still the starting value at this point, because the transition has only just begun, and
 * it is the current value too when a slide is reversed halfway.
 */
export function holdColumnWidth(frame: HTMLElement, navAfter: number): () => void {
	const main = frame.parentElement?.querySelector<HTMLElement>(":scope > main");
	if (!main || main.offsetWidth === 0) return () => {};
	const navNow = frame.offsetWidth + Number.parseFloat(getComputedStyle(frame).marginLeft);
	const scale = (main.offsetWidth + navNow - navAfter) / main.offsetWidth;
	if (Math.abs(scale - 1) < 0.001) return () => {};

	// Every pane is placed in shares of the dock, so its destination is its width scaled with the dock's.
	const panes = [...main.querySelectorAll<HTMLElement>(".ly-dock-pane")].filter((pane) => pane.parentElement);
	const probe = (pane: HTMLElement, width: number) => {
		const box = document.createElement("div");
		box.className = "ly-dock-pane";
		box.style.cssText = `position:absolute;left:0;top:0;height:0;visibility:hidden;pointer-events:none;width:${width}px`;
		const column = box.appendChild(document.createElement("div"));
		column.style.width = "var(--ly-content)";
		// Beside the pane, so the probe inherits whatever `--ly-content` the pane does when no query matches.
		pane.parentElement?.appendChild(box);
		return { box, column };
	};
	const probes = panes.map((pane) => [probe(pane, pane.offsetWidth), probe(pane, pane.offsetWidth * scale)] as const);
	// All inserted before any is read: one layout for the lot.
	const caps = probes.map((pair) => pair.map(({ column }) => Number.parseFloat(getComputedStyle(column).width)));
	for (const { box } of probes.flat()) box.remove();

	const held: HTMLElement[] = [];
	panes.forEach((pane, index) => {
		const [capFrom, capTo] = caps[index];
		if (!(capFrom > 0 && capTo > 0)) return;
		const from = pane.offsetWidth;
		const to = from * scale;
		const box = (width: number) => `(100% - 100cqw + ${width}px)`;
		const start = `min(${box(from)}, ${capFrom}px)`;
		const end = `min(${box(to)}, ${capTo}px)`;
		const value =
			to < from
				? end
				: // The straight line from start to end, unless the end fits already — then it is the end.
					`max(${start} + (${end} - ${start}) * ((100cqw - ${from}px) / ${to - from}px), ${end} - max(${end} - ${box(from)}, 0px) * 10000)`;
		// Inline, on the elements the stylesheet sets it on (`.ly-dock-pane > *`), so it wins over the query.
		for (const child of pane.children) {
			if (!(child instanceof HTMLElement)) continue;
			child.style.setProperty("--ly-content", `calc(${value})`);
			held.push(child);
		}
	});

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		for (const element of held) element.style.removeProperty("--ly-content");
		frame.removeEventListener("transitionend", onEnd);
		window.clearTimeout(timer);
	};
	const onEnd = (event: TransitionEvent) => {
		if (event.target === frame && event.propertyName === "margin-left") release();
	};
	frame.addEventListener("transitionend", onEnd);
	const timer = window.setTimeout(release, FALLBACK_MS);
	return release;
}
