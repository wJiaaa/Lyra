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
 * A column that does not fit at its destination width yet — the sidebar closing beside a narrow pane,
 * or beside the right column — takes it anyway and runs past the pane's right edge, where the card
 * clips it (`wide` below). It used to grow in step with the pane instead, and growing is rewrapping:
 * at 1512px with the right column open every line rebroke six times in one slide, which reads as the
 * text shaking. A cut at the card's edge that the slide uncovers is one motion.
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
	/*
	 * The panes are shares of the split viewport, not of `main`: around the viewport is the workspace's
	 * own padding (`.ly-frames`), which stays put while the viewport takes the whole of the change.
	 */
	const room = main.querySelector<HTMLElement>("[data-ly-split-viewport]") ?? main;
	const scale = (room.offsetWidth + navNow - navAfter) / room.offsetWidth;
	if (Math.abs(scale - 1) < 0.001) return () => {};

	/*
	 * Each screen is a share of the viewport and scales with it; inside a screen, the panel column beside
	 * the conversation is pixels from the right (`across` in `DockView`) and keeps its width, so whatever
	 * the screen gains or loses is the conversation's alone. Held, that panel's column would take a
	 * destination it never reaches — its composer jumped 115px narrower on the first frame.
	 */
	const panes = [...main.querySelectorAll<HTMLElement>(".ly-dock-pane")].filter((pane) => pane.parentElement && !pane.style.width.endsWith("px"));
	const unhold = holdColumns(
		panes.map((pane) => ({ pane, from: pane.offsetWidth, to: pane.offsetWidth + pane.parentElement!.offsetWidth * (scale - 1) })),
		{ wide: true },
	);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		unhold();
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

/** The columns that read `--ly-content`. */
const COLUMN = '[class*="max-w-[var(--ly-content)]"]';

/**
 * Hold each pane's column at the width it will have at `to`, for a pane going from `from` pixels wide
 * to `to`, and hand back the release. The sidebar's slide above, and the right column's in `DockView`.
 *
 * `wide`: a column that does not fit yet takes its destination width anyway and runs past the pane's
 * right edge, where the card clips it (`[data-ly-column-wide]` in `dock.css`). Without it the column
 * grows with the pane, rewrapping on every frame.
 */
export function holdColumns(panes: { pane: HTMLElement; from: number; to: number }[], { wide = false } = {}): () => void {
	/*
	 * The breakpoints read the pane's width, but `100cqw` in `--ly-content` resolves where it is used,
	 * against the nearest size container — and in the conversation that is two boxes: the transcript
	 * has a container of its own inside the card, the composer has only the pane. The card's inset and
	 * border make them 6px apart, and one value for both held the composer 6px off its destination,
	 * a jump as the slide began and another as it let go. So each container gets a value of its own,
	 * counted in its own widths: `inset` is how much narrower than the pane it is.
	 */
	const holds = panes.flatMap(({ pane, from, to }) => {
		const containers = new Set<HTMLElement>();
		for (const column of pane.querySelectorAll<HTMLElement>(COLUMN)) containers.add(containerOf(column, pane));
		// The pane first: see where the values are set below.
		return [...containers].sort((a, b) => Number(b === pane) - Number(a === pane)).map((container) => ({ pane, container, inset: pane.offsetWidth - contentWidth(container), from, to }));
	});
	const probe = (pane: HTMLElement, width: number, inset: number) => {
		const box = document.createElement("div");
		box.className = "ly-dock-pane";
		box.style.cssText = `position:absolute;left:0;top:0;height:0;visibility:hidden;pointer-events:none;width:${width}px`;
		const inside = box.appendChild(document.createElement("div"));
		inside.style.cssText = `container-type:inline-size;width:${width - inset}px`;
		const column = inside.appendChild(document.createElement("div"));
		column.style.width = "var(--ly-content)";
		// Beside the pane, so the probe inherits whatever `--ly-content` the pane does when no query matches.
		pane.parentElement?.appendChild(box);
		return { box, column };
	};
	const probes = holds.map(({ pane, inset, from, to }) => [probe(pane, from, inset), probe(pane, to, inset)] as const);
	// All inserted before any is read: one layout for the lot.
	const caps = probes.map((pair) => pair.map(({ column }) => Number.parseFloat(getComputedStyle(column).width)));
	for (const { box } of probes.flat()) box.remove();

	const held: HTMLElement[] = [];
	const widened = new Set<HTMLElement>();
	holds.forEach(({ pane, container, inset, from: paneFrom, to: paneTo }, index) => {
		const [capFrom, capTo] = caps[index];
		if (!(capFrom > 0 && capTo > 0)) return;
		const from = paneFrom - inset;
		const to = paneTo - inset;
		const box = (width: number) => `(100% - 100cqw + ${width}px)`;
		const start = `min(${box(from)}, ${capFrom}px)`;
		const end = `min(${box(to)}, ${capTo}px)`;
		const value =
			to < from || wide
				? end
				: // The straight line from start to end, unless the end fits already — then it is the end.
					`max(${start} + (${end} - ${start}) * ((100cqw - ${from}px) / ${to - from}px), ${end} - max(${end} - ${box(from)}, 0px) * 10000)`;
		if (wide && to > from) widened.add(pane);
		/*
		 * Inline, so it wins over the query. For the pane, on the elements the stylesheet sets it on
		 * (`.ly-dock-pane > *`); for a container inside it, on the container, where it shadows the
		 * pane's for everything in there. The pane comes first in `holds`, so a container that is also
		 * a child of the pane ends up with its own.
		 */
		const targets = container === pane ? [...pane.children] : [container];
		for (const target of targets) {
			if (!(target instanceof HTMLElement)) continue;
			target.style.setProperty("--ly-content", `calc(${value})`);
			held.push(target);
		}
	});
	for (const pane of widened) pane.setAttribute("data-ly-column-wide", "");

	return () => {
		for (const element of held) element.style.removeProperty("--ly-content");
		for (const pane of widened) pane.removeAttribute("data-ly-column-wide");
	};
}

/** The size container `100cqw` resolves against at `column`, which is `pane` when nothing nearer is one. */
function containerOf(column: HTMLElement, pane: HTMLElement): HTMLElement {
	for (let at = column.parentElement; at && at !== pane; at = at.parentElement) {
		if (getComputedStyle(at).containerType !== "normal") return at;
	}
	return pane;
}

/** The width `100cqw` is: the container's content box. */
function contentWidth(element: HTMLElement): number {
	const style = getComputedStyle(element);
	return element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
}
