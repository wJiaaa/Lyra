/**
 * The place a tag still being written will stand, drawn as a building site: a field of dots that
 * ripples out from the centre, a probe line running across and lighting the dots it passes, and the
 * outline marked by dotted guides with a handle at each corner. The look is transitions.dev's
 * generation effect, kept to what reads at a glance — its size counters, labels and coordinate
 * readouts were noise at the size of a chart in a reply.
 *
 * Dots are on a canvas: a chart's place holds a few hundred, and each is lit per frame.
 */

import { motionReduced } from "../../../ui/motion/reduced.ts";

/** The grid the dots sit on. `.ly-ui-trace` lays its field on the same one, so the hand-over does not shift. */
const DOT_GAP = 15;
/** The outline sits this far inside the box: the block clips while it is written, and a handle on the edge lost half of itself. */
const INSET = 3;
const SVG = "http://www.w3.org/2000/svg";
const RIPPLE = 900;
const SWEEP = 1700;

const easeOut = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** A colour from the stylesheet, resolved: a canvas cannot read a custom property. */
function resolveColour(host: HTMLElement, name: string): string {
	const probe = document.createElement("span");
	probe.style.color = `var(${name})`;
	host.append(probe);
	const colour = getComputedStyle(probe).color;
	probe.remove();
	return colour;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG, tag);
	for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
	parent.append(element);
	return element;
}

/** Draws into `host` and keeps it moving until the returned function is called. */
export function buildSite(host: HTMLElement): () => void {
	const w = host.clientWidth;
	const h = host.clientHeight;
	if (!w || !h) return () => {};
	const still = motionReduced();
	const ratio = devicePixelRatio || 1;
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(w * ratio);
	canvas.height = Math.round(h * ratio);
	const context = canvas.getContext("2d");
	if (!context) return () => {};
	context.scale(ratio, ratio);

	const frame = svg("svg", { width: w, height: h }, host);
	host.prepend(canvas);
	const [left, top, right, bottom] = [INSET, INSET, w - INSET, h - INSET];
	// Each edge drawn from one corner past the next, as a ruler would be laid.
	const edges: [number, number, number, number][] = [
		[0, top, w, top],
		[right, top - 8, right, bottom + 8],
		[w, bottom, 0, bottom],
		[left, bottom + 8, left, top - 8],
	];
	const guides = edges.map(([x1, y1, x2, y2]) => ({ line: svg("line", { x1, y1, x2: x1, y2: y1, class: "ly-ui-guide" }, frame), x1, y1, x2, y2 }));
	[[left, top], [right, top], [right, bottom], [left, bottom]].forEach(([x, y], index) => {
		const handle = svg("rect", { x: x! - 2.5, y: y! - 2.5, width: 5, height: 5, class: "ly-ui-handle" }, frame);
		if (!still) handle.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 320, delay: 380 + index * 50, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" });
	});

	const rest = resolveColour(host, "--ly-ui-dot");
	const lit = resolveColour(host, "--ly-ui-dot-lit");
	const cols = Math.max(1, Math.floor((w - 2 * INSET) / DOT_GAP) + 1);
	const rows = Math.max(1, Math.floor((h - 2 * INSET) / DOT_GAP) + 1);
	const ox = (w - (cols - 1) * DOT_GAP) / 2;
	const oy = (h - (rows - 1) * DOT_GAP) / 2;
	const far = Math.hypot(w / 2, h / 2) + DOT_GAP;
	const start = performance.now();
	let raf = 0;

	const paint = (now: number) => {
		const t = still ? Number.POSITIVE_INFINITY : now - start;
		const reach = still ? far : easeOut(t / RIPPLE) * far;
		// Starts once the ripple is mostly out, then runs across and off the far side, again and again.
		const probe = still ? Number.NaN : (((t - 300) / SWEEP) % 1) * (w + 120) - 60;
		guides.forEach((guide, index) => {
			const q = easeOut((t - 80 - index * 70) / 500);
			guide.line.setAttribute("x2", String(guide.x1 + (guide.x2 - guide.x1) * q));
			guide.line.setAttribute("y2", String(guide.y1 + (guide.y2 - guide.y1) * q));
		});
		context.clearRect(0, 0, w, h);
		for (let i = 0; i < cols; i++) {
			const x = ox + i * DOT_GAP;
			for (let j = 0; j < rows; j++) {
				const y = oy + j * DOT_GAP;
				const distance = Math.hypot(x - w / 2, y - h / 2);
				if (distance > reach) continue;
				// The ripple's front and the probe both light what they cross.
				const front = t < RIPPLE + 200 ? Math.exp(-(((reach - distance - 6) / 14) ** 2)) : 0;
				const glow = Math.max(front, Number.isNaN(probe) ? 0 : Math.exp(-(((x - probe) / 10) ** 2)));
				context.globalAlpha = glow > 0.05 ? 0.4 + 0.6 * glow : 1;
				context.fillStyle = glow > 0.05 ? lit : rest;
				context.beginPath();
				context.arc(x, y, 1.1 + glow * 0.6, 0, Math.PI * 2);
				context.fill();
			}
		}
		context.globalAlpha = 1;
		if (!still) raf = requestAnimationFrame(paint);
	};
	paint(start);
	if (!still) raf = requestAnimationFrame(paint);
	return () => {
		cancelAnimationFrame(raf);
		canvas.remove();
		frame.remove();
	};
}
