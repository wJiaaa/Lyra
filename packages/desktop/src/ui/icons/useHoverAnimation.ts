import { motion } from "motion/react";
import { createElement, forwardRef, useCallback, useEffect, useRef, useState, type ForwardedRef } from "react";
import { motionReduced } from "../motion/reduced.ts";

/** Whose hover plays the icon: the control it sits in, not the glyph alone. */
const HOST = 'button, a, summary, label, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"]';

/** Motion's own props, which a plain element must not pass on to the DOM. */
const MOTION_PROPS = new Set(["animate", "initial", "exit", "variants", "transition", "custom", "whileHover", "whileTap", "onAnimationComplete"]);

/** Style keys only motion understands (`originX` is its transform origin); CSS has no such property. */
const MOTION_STYLE = new Set(["originX", "originY", "originZ"]);

const plain = new Map<string, unknown>();

/**
 * `motion` without the motion: the same `still.path`, `still.svg`, … rendering the bare element.
 *
 * An icon is drawn with these until it is first hovered. A Git panel with 300 changed files draws
 * some 600 row-action icons; as motion components they took the panel's main-thread long tasks
 * from about 33ms to about 117ms, for animations almost none of them will ever play.
 *
 * An element with an `initial` is still a motion one: its resting look lives in that pose (binary's
 * digits, bot's eyes, send's hidden trail), not in its attributes, and drawn bare it shows the wrong
 * thing. None of the icons that come by the hundred has one.
 */
const still = new Proxy({} as typeof motion, {
	get(_, tag: string) {
		let component = plain.get(tag);
		if (!component) {
			const animated = (motion as unknown as Record<string, unknown>)[tag];
			component = forwardRef<Element, Record<string, unknown>>(function Still(props, ref) {
				if (props.initial !== undefined && props.initial !== false) return createElement(animated as string, { ...props, ref });
				const rest: Record<string, unknown> = { ref };
				for (const key in props) if (!MOTION_PROPS.has(key)) rest[key] = props[key];
				if (rest.style && typeof rest.style === "object") {
					rest.style = Object.fromEntries(Object.entries(rest.style).filter(([key]) => !MOTION_STYLE.has(key)));
				}
				return createElement(tag, rest);
			});
			plain.set(tag, component);
		}
		return component;
	},
});

/**
 * Plays an animated icon when the pointer enters the control around it, so a call site writes
 * `<Bell size={15} />` exactly as it would the static lucide icon.
 *
 * Upstream (lucide-animated) listens on a wrapper only as big as the glyph; the whole control is
 * what should answer the pointer. An icon outside any control falls back to itself, which is
 * upstream's behaviour. Mouse only, and not while the control holds `:focus-visible` — a keyboard
 * user moving through a toolbar is not hovering. Reduced motion is read at the moment of entering,
 * as in `motionReduced`. Leaving always resets, so a played icon never stays posed.
 *
 * Returns the ref for the `<svg>` (it also fills the caller's own ref, as lucide's icons do) and
 * `M`, which the icon draws its elements with in place of `motion`: `still` until the first hover,
 * `motion` from then on. Switching remounts the elements under the pointer, so the first play
 * starts a frame later, once the motion elements exist to take it.
 */
export function useHoverAnimation(
	forwarded: ForwardedRef<SVGSVGElement>,
	start: () => void,
	stop: () => void,
): { ref: (svg: SVGSVGElement | null) => void; M: typeof motion } {
	const icon = useRef<SVGSVGElement | null>(null);
	const [live, setLive] = useState(false);
	const pending = useRef(false);
	const liveRef = useRef(false);
	// The latest pair, so the listeners attached once at mount never call a stale one.
	const play = useRef({ start, stop });
	useEffect(() => {
		play.current = { start, stop };
	});
	useEffect(() => {
		liveRef.current = live;
		if (live && pending.current) {
			pending.current = false;
			play.current.start();
		}
	}, [live]);
	useEffect(() => {
		const svg = icon.current;
		if (!svg) return;
		const host = svg.closest<HTMLElement>(HOST) ?? svg;
		const enter = (event: Event) => {
			if (!(event instanceof PointerEvent) || event.pointerType !== "mouse" || host.matches(":focus-visible") || motionReduced()) return;
			if (liveRef.current) play.current.start();
			else {
				pending.current = true;
				setLive(true);
			}
		};
		const leave = () => {
			pending.current = false;
			if (liveRef.current) play.current.stop();
		};
		host.addEventListener("pointerenter", enter);
		host.addEventListener("pointerleave", leave);
		return () => {
			host.removeEventListener("pointerenter", enter);
			host.removeEventListener("pointerleave", leave);
		};
	}, []);
	const ref = useCallback(
		(svg: SVGSVGElement | null) => {
			// The svg is replaced when `M` turns live; the host it sits in is the same control.
			if (svg) icon.current = svg;
			if (typeof forwarded === "function") forwarded(svg);
			else if (forwarded) forwarded.current = svg;
		},
		[forwarded],
	);
	return { ref, M: live ? motion : still };
}
