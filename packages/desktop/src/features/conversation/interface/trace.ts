/**
 * An element that has just arrived is laid down over a second. Its outline and each part in it — a
 * box with a ground or a border, each line of text, a chart's grid lines and marks — are traced in dotted lines, in document order,
 * a brighter dot at the tip, over the same field of dots its placeholder had (`site.ts`). Then a line
 * runs down it, uncovering the element above the line and wiping the drawing away as it goes.
 *
 * transitions.dev's generation effect, written down to what shows: the parts and the reveal, not its
 * counters, labels or reticle. Only for a chart or a table, which have parts worth tracing; a row of
 * buttons is uncovered without the drawing (`arrive.ts`).
 */

const SVG = "http://www.w3.org/2000/svg";
const DURATION = 1000;
/** Fractions of `DURATION`: the parts are drawn in the first, the element is uncovered in the second. */
const DRAW = [0.04, 0.58] as const;
const REVEAL = [0.52, 1] as const;
/** Past this a table's every cell is a part, and the drawing reads as noise rather than as a sequence. */
const MAX_PARTS = 30;
const SPACING = 4.8;
const BOXY = /^(BUTTON|INPUT|SELECT|TEXTAREA|IMG|CANVAS|VIDEO)$/;

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - (1 - clamp(x)) ** 3;
const smooth = (x: number) => clamp(x) * clamp(x) * (3 - 2 * clamp(x));

function rounded(x: number, y: number, w: number, h: number, radius: number): string {
	const r = Math.max(0, Math.min(radius, w / 2, h / 2));
	return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** No ground at all: `transparent`, or any colour whose alpha is written as zero. */
const clear = (colour: string) => colour === "transparent" || /,\s*0(?:\.0+)?\)$/.test(colour) || /\/\s*0(?:\.0+)?\)$/.test(colour);

/** A chart's marks — its grid lines, bars, lines and slices — appended with their offset from `box`. */
function marks(chart: SVGSVGElement, box: DOMRect, paths: string[]): void {
	for (const mark of chart.querySelectorAll<SVGGeometryElement>("line, polyline, rect, path")) {
		if (paths.length >= MAX_PARTS) return;
		// The rect laid over the plot to catch the pointer has no ground: nothing to see, nothing to trace.
		if (mark instanceof SVGRectElement && clear(getComputedStyle(mark).fill)) continue;
		const at = mark.getScreenCTM();
		if (!at) continue;
		// Kept in the mark's own units and moved into place: a pie is drawn about its centre.
		const d =
			mark instanceof SVGPolylineElement
				? `M${[...mark.points].map((point) => `${point.x} ${point.y}`).join("L")}`
				: mark instanceof SVGLineElement
					? `M${mark.x1.baseVal.value} ${mark.y1.baseVal.value}L${mark.x2.baseVal.value} ${mark.y2.baseVal.value}`
					: mark instanceof SVGRectElement
						? rounded(mark.x.baseVal.value, mark.y.baseVal.value, mark.width.baseVal.value, mark.height.baseVal.value, mark.rx.baseVal.value)
						: (mark.getAttribute("d") ?? "");
		if (d) paths.push(`${d}|${at.e - box.left} ${at.f - box.top}`);
	}
}

/**
 * The element's outline, then its framed boxes, its lines of text and a chart's marks, as path data
 * relative to it. A chart's marks carry their offset after `|`: they are in the chart's units.
 */
function shapes(node: HTMLElement): string[] {
	const box = node.getBoundingClientRect();
	const paths = [rounded(0, 0, box.width, box.height, parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0)];
	const seen: DOMRect[] = [box];
	const lines = (element: Element) => {
		for (const child of element.childNodes) {
			if (child.nodeType !== Node.TEXT_NODE || !child.nodeValue?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(child);
			for (const rect of range.getClientRects()) {
				if (paths.length >= MAX_PARTS) return;
				const y = rect.top - box.top + rect.height * 0.56;
				paths.push(`M${rect.left - box.left} ${y}H${rect.right - box.left}`);
			}
		}
	};
	const visit = (element: Element) => {
		lines(element);
		for (const child of element.children) {
			if (paths.length >= MAX_PARTS) return;
			const rect = child.getBoundingClientRect();
			const style = getComputedStyle(child);
			if (style.display === "none" || style.visibility === "hidden") continue;
			if (rect.width && rect.height) {
				const framed = child instanceof SVGSVGElement || BOXY.test(child.tagName) || !clear(style.backgroundColor) || parseFloat(style.borderTopWidth) > 0;
				// A button and the span that fills it are one box.
				const again = seen.some((other) => Math.abs(other.left - rect.left) < 1.5 && Math.abs(other.top - rect.top) < 1.5 && Math.abs(other.width - rect.width) < 1.5 && Math.abs(other.height - rect.height) < 1.5);
				if (framed && !again) {
					paths.push(rounded(rect.left - box.left, rect.top - box.top, rect.width, rect.height, parseFloat(style.borderTopLeftRadius) || 0));
					seen.push(rect);
				}
			}
			if (child instanceof SVGSVGElement) marks(child, box, paths);
			else if (!(child instanceof SVGElement)) visit(child);
		}
	};
	visit(node);
	return paths;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG, tag);
	for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
	parent.append(element);
	return element;
}

export function trace(node: HTMLElement, layer: HTMLElement): void {
	const origin = layer.getBoundingClientRect();
	const box = node.getBoundingClientRect();
	const { width: w, height: h } = box;
	const kept = { opacity: node.style.opacity, clipPath: node.style.clipPath, filter: node.style.filter };
	// Hidden until the line reaches it. Set here, in the same task as React's commit, so it never shows whole first.
	node.style.opacity = "0";

	const overlay = document.createElement("div");
	overlay.className = "ly-ui-trace";
	Object.assign(overlay.style, { left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${w}px`, height: `${h}px` });
	const drawing = svg("svg", { width: w, height: h }, overlay);
	const scan = document.createElement("div");
	scan.className = "ly-ui-scan";
	overlay.append(scan);
	layer.append(overlay);

	const found = shapes(node);
	// Later parts start later, but each takes the same time: the drawing runs as a sequence, not all at once.
	const span = DRAW[1] - DRAW[0];
	const each = Math.min(0.24, span * 0.5);
	const strokes = found.map((shape, index) => {
		const [d = "", offset] = shape.split("|");
		const moved: Record<string, string> = offset ? { transform: `translate(${offset})` } : {};
		const path = svg("path", { d, class: "ly-ui-wire", ...moved }, drawing);
		const from = DRAW[0] + (found.length > 1 ? ((span - each) * index) / (found.length - 1) : 0);
		return { path, tip: svg("circle", { r: 2.2, class: "ly-ui-tip", opacity: 0, ...moved }, drawing), length: path.getTotalLength(), from, to: from + each, dots: -1 };
	});

	const start = performance.now();
	const finish = () => {
		Object.assign(node.style, kept);
		overlay.remove();
	};
	const paint = (now: number) => {
		// Unmounted mid-way — the session switched, the reply was replaced. Nothing left to show it on.
		if (!node.isConnected) return finish();
		const p = (now - start) / DURATION;
		for (const stroke of strokes) {
			const q = easeOut((p - stroke.from) / (stroke.to - stroke.from));
			const dots = q > 0 ? Math.floor((stroke.length * q) / SPACING) + 1 : 0;
			if (dots !== stroke.dots) {
				stroke.dots = dots;
				stroke.path.style.strokeDasharray = dots ? `${`0 ${SPACING} `.repeat(dots - 1)}0 ${stroke.length + 10}` : `0 ${stroke.length + 10}`;
				stroke.path.style.opacity = dots ? "1" : "0";
			}
			const live = q > 0 && q < 1;
			stroke.tip.setAttribute("opacity", live ? "1" : "0");
			if (live) {
				const at = stroke.path.getPointAtLength(Math.floor((stroke.length * q) / SPACING) * SPACING);
				stroke.tip.setAttribute("cx", String(at.x));
				stroke.tip.setAttribute("cy", String(at.y));
			}
		}
		const r = smooth((p - REVEAL[0]) / (REVEAL[1] - REVEAL[0]));
		const y = easeOut(r) * h;
		if (r > 0 && r < 1) {
			node.style.opacity = "1";
			node.style.clipPath = `inset(-8px -8px ${h - y}px -8px)`;
			node.style.filter = `blur(${2 * (1 - r)}px)`;
		}
		// Above the line the element is in; the drawing and the dots there are gone.
		overlay.style.clipPath = `inset(${y}px -4px -4px -4px)`;
		scan.style.top = `${y}px`;
		scan.style.opacity = r > 0 && r < 1 ? "1" : "0";
		if (p >= REVEAL[1]) return finish();
		requestAnimationFrame(paint);
	};
	// The first frame now, before the browser paints: the paths are solid lines until it sets their dots.
	paint(start);
}
