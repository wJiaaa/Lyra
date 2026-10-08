import { useEffect, useRef, useState } from "react";

import { freezeMotion } from "../motion/freeze.ts";

/**
 * How far the pointer can wander from the edge and still be grabbing it.
 *
 * Almost all of it on the far side of the boundary — see `INSIDE`.
 */
const HIT_WIDTH = 9;
/**
 * How much of that strip lies within the pane being resized.
 *
 * One pixel, and it is there so the boundary itself is grabbable rather than only the content
 * beside it. The rest hangs over the neighbour.
 *
 * The reason is the scrollbar. A pane's scroller puts its thumb on the last few pixels of the same
 * edge, and a thumb is only reachable while its scroller is hovered — which a pointer resting on
 * the handle is not doing. Sharing the strip therefore does not merely make the two compete; it
 * makes the scrollbar draggable or not depending on which direction the pointer arrived from,
 * because approaching across the list hovers the scroller on the way in and approaching from the
 * content does not. No z-order fixes that. Stepping the hit area over to the other side does, and
 * costs nothing visible: the thumb occupies pixels 2 through 8 measured from the pane's edge, so
 * one pixel of overlap leaves them disjoint.
 */
const INSIDE = 1;
/** Keyboard resizing, per press. Shift multiplies it, the way nudging does everywhere else. */
const STEP = 16;

/**
 * The draggable edge of a pane.
 *
 * What appears is a line down the whole edge, and only while the pointer is on it or dragging.
 * It used to be a 30px grip following the pointer, on the grounds that a full-height line reads as
 * a border; but it is never there at rest, so it cannot be mistaken for layout, and a stub that
 * slides along with the pointer looked like an artefact rather than "this whole edge moves".
 *
 * The target straddles the boundary with almost all of it on the neighbour's side, which is what
 * keeps it clear of the scrollbar inside the pane — see `INSIDE`. Whoever renders this has to give
 * it a positioning context that does not clip: a pane clips its own overflow, so a handle hanging
 * outside one would simply be cut off. `NavPane` wraps the pane in a frame for exactly that.
 *
 * Reports an absolute width rather than a delta, computed from where the drag started. Summing
 * deltas per mousemove accumulates the clamping error: drag past the minimum, come back, and the
 * pane is short by however far past it you went.
 */
export function ResizeHandle({
	edge,
	width,
	min,
	max,
	onResize,
	onReset,
	label,
}: {
	/** Which side of the pane this is on: `end` for a left-hand pane, `start` for a right-hand one. */
	edge: "start" | "end";
	width: number;
	min: number;
	max: number;
	onResize: (next: number) => void;
	/** Double-click restores the default. */
	onReset?: () => void;
	label: string;
}) {
	const track = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(false);
	/*
	 * Whether the line is showing. State rather than `:hover` because it also has to survive the
	 * drag: once the pointer leaves the 9px strip the handle is no longer hovered, and a line that
	 * vanished mid-drag would leave you dragging an invisible edge.
	 */
	const [lit, setLit] = useState(false);
	const start = useRef({ x: 0, width: 0 });

	useEffect(() => {
		if (!active) return;

		/*
		 * One update per frame, not one per event.
		 *
		 * `mousemove` fires faster than the screen refreshes — noticeably so on a 120Hz trackpad —
		 * and this handler did three expensive things every time: a `setState` that re-renders the
		 * whole window, a `getBoundingClientRect` that forces layout synchronously, and a second
		 * `setState`. Several of those inside one frame is a layout thrash, and with a multi-pane
		 * dock on the other side of the drag it showed up as the panes juddering while the handle
		 * moved smoothly.
		 *
		 * Coalescing to `requestAnimationFrame` means the work happens exactly as often as it can
		 * be seen, and the measurement happens at the point in the frame where layout is settled
		 * anyway.
		 */
		let frame = 0;
		let pending: MouseEvent | null = null;

		const apply = () => {
			frame = 0;
			const event = pending;
			pending = null;
			if (!event) return;

			const travel = event.clientX - start.current.x;
			const next = edge === "end" ? start.current.width + travel : start.current.width - travel;
			onResize(Math.min(max, Math.max(min, next)));
		};

		const onMove = (event: MouseEvent) => {
			pending = event;
			if (!frame) frame = requestAnimationFrame(apply);
		};
		/*
		 * Put the line out too, unless the pointer came to rest back on the edge.
		 *
		 * A drag almost always ends somewhere else — that is the point of it — and `mouseleave`
		 * cannot report that, because the pointer left this element long before the button came up.
		 */
		const stop = (event: MouseEvent) => {
			setActive(false);
			if (!over(track.current, event)) setLit(false);
		};

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", stop);
		/*
		 * The cursor and the selection guard go on <body>, not on the handle.
		 *
		 * Once a drag is under way the pointer spends most of its time over the panes on either
		 * side, and a `cursor` on the handle only applies while the pointer is actually over it —
		 * so it would flicker back to a text caret the moment the drag left the 9px strip.
		 */
		document.body.style.cursor = "col-resize";
		// Freezes transitions for the length of the drag, so the pane tracks the pointer instead
		// of easing towards each intermediate width and never arriving — and refuses the selection
		// a drag across the content would start. Both by naming things rather than by a flag on the
		// root, which sits above the transcript; see `motion-freeze.ts`.
		const thaw = freezeMotion();
		document.documentElement.dataset.resizing = "";

		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", stop);
			// A drag that ends mid-frame leaves nothing scheduled against an unmounted handle.
			if (frame) cancelAnimationFrame(frame);
			document.body.style.cursor = "";
			thaw();
			delete document.documentElement.dataset.resizing;
		};
	}, [active, edge, min, max, onResize]);

	/*
	 * `mouseleave` is not enough to know the pointer has gone.
	 *
	 * It is not delivered when the pointer crosses the whole element between two frames — a quick
	 * flick past a nine-pixel strip does exactly that — and it is not delivered at all when the
	 * pointer leaves the window, which is the case somebody notices: the line stays lit on an edge
	 * nothing is near, and nothing will ever come along to put it out.
	 *
	 * So the question is asked the other way round. While the line is showing, every pointer move
	 * anywhere re-checks whether it is still over this strip, and leaving the document or the
	 * window at all settles it immediately. Only while not dragging — during a drag the pointer is
	 * meant to be far away and the line is meant to stay.
	 */
	useEffect(() => {
		if (!lit || active) return;
		const check = (event: MouseEvent) => {
			if (!over(track.current, event)) setLit(false);
		};
		const gone = () => setLit(false);
		// `mouseout` with no relatedTarget is the pointer crossing the window's own boundary.
		const out = (event: MouseEvent) => {
			if (!event.relatedTarget) gone();
		};
		window.addEventListener("mousemove", check);
		document.addEventListener("mouseout", out);
		window.addEventListener("blur", gone);
		return () => {
			window.removeEventListener("mousemove", check);
			document.removeEventListener("mouseout", out);
			window.removeEventListener("blur", gone);
		};
	}, [lit, active]);

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			ref={track}
			onMouseEnter={() => setLit(true)}
			// Again on move: the window-level check above can put it out while the pointer is still here.
			onMouseMove={() => setLit(true)}
			onMouseLeave={() => {
				// Stays put while dragging: the pointer is usually well outside the strip by then.
				if (!active) setLit(false);
			}}
			onMouseDown={(event) => {
				// Left button only: a right-click here should not start a silent drag.
				if (event.button !== 0) return;
				event.preventDefault();
				start.current = { x: event.clientX, width };
				setActive(true);
			}}
			onDoubleClick={onReset}
			onKeyDown={(event) => {
				const step = event.shiftKey ? STEP * 4 : STEP;
				// Arrows move the edge itself, so left always narrows a left-hand pane.
				const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
				const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
				if (event.key === grow) onResize(Math.min(max, width + step));
				else if (event.key === shrink) onResize(Math.max(min, width - step));
				else if (event.key === "Home") onReset?.();
				else return;
				event.preventDefault();
			}}
			// Pushed out by everything except `INSIDE`, so the strip lands beyond the pane's edge.
			style={{ width: HIT_WIDTH, [edge === "end" ? "right" : "left"]: INSIDE - HIT_WIDTH }}
			className="group/resize absolute top-0 bottom-0 z-30 cursor-col-resize"
		>
			{/*
			 * Drawn on the boundary itself — the *near* edge of this strip, since the strip stepped
			 * over to the neighbour's side — so what lights up is the seam between two panes and not
			 * a mark floating in the content.
			 */}
			{lit && (
				<span
					aria-hidden
					className={`absolute top-0 bottom-0 w-[3px] rounded-full transition-colors duration-[var(--ly-t-quick)] ${
						edge === "end" ? "left-0" : "right-0"
					} ${active ? "bg-accent" : "bg-ink-faint/45"}`}
				/>
			)}
		</div>
	);
}

/** Whether a pointer event landed within an element's box. Null element counts as "no". */
function over(element: HTMLElement | null, event: MouseEvent): boolean {
	if (!element) return false;
	const box = element.getBoundingClientRect();
	return (
		event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
	);
}
