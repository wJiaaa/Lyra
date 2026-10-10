/**
 * Bar, line, area and pie charts for interface blocks, drawn as SVG in the box they are given.
 *
 * Drawn at the width the reply has, measured, rather than in a fixed viewBox stretched to fit: a
 * stretched chart stretches its labels and thickens its lines with the window, and the same block is
 * read in a full pane and in a side chat a third as wide. The height is one of three steps.
 *
 * Which rows, labels and series a block's data comes to is the language's (`chartData`): the phone
 * reads the same block into the same rows.
 */

import { useLayoutEffect, useState, type PointerEvent } from "react";
import { chartData, chartValue as value, text } from "@plume/core/ui-language";

const HEIGHT: Record<string, number> = { sm: 140, md: 200, lg: 280 };
const colour = (index: number) => `var(--ly-chart-${(index % 6) + 1})`;

/** A top for the axis that reads as a round number, and the ticks up to it. */
function ticks(low: number, high: number): number[] {
	const span = high - low || Math.abs(high) || 1;
	const rough = span / 4;
	const power = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= rough) ?? rough;
	const start = Math.floor(low / step) * step;
	const out: number[] = [];
	for (let at = start; at <= high + step * 1e-9; at += step) out.push(Number(at.toFixed(10)));
	if (out.at(-1)! < high) out.push(out.at(-1)! + step);
	return out;
}

function short(number: number): string {
	const abs = Math.abs(number);
	if (abs >= 1e9) return `${+(number / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${+(number / 1e6).toFixed(1)}M`;
	if (abs >= 1e4) return `${+(number / 1e3).toFixed(1)}k`;
	return String(+number.toFixed(2));
}

/** The box's width, kept current. A callback ref: the box is not there on a render that draws no chart. */
function useWidth() {
	const [element, box] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!element) return;
		const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return { box, width };
}

function Legend({ names, unit, totals }: { names: string[]; unit?: string; totals?: number[] }) {
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-muted">
			{names.map((name, index) => (
				<span key={index} className="inline-flex items-center gap-1.5">
					<span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colour(index) }} />
					{name}
					{totals && <span className="text-ink tabular-nums">{`${short(totals[index]!)}${unit ?? ""}`}</span>}
				</span>
			))}
		</div>
	);
}

export function Chart({ kind = "bar", data, x, y, unit, size }: { kind?: string; data?: unknown[]; x?: string; y?: unknown; unit?: string; size?: string }) {
	const { rows, labels, keys } = chartData(data, x, y);
	const { box, width } = useWidth();
	const [hover, setHover] = useState<number | null>(null);
	const height = HEIGHT[size ?? "md"] ?? HEIGHT.md!;
	if (!rows.length || !keys.length) return null;

	if (kind === "pie") {
		const values = rows.map((row) => Math.max(0, value(row, keys[0]!)));
		const total = values.reduce((sum, item) => sum + item, 0) || 1;
		const radius = height / 2 - 4;
		let angle = -Math.PI / 2;
		const slices = values.map((item, index) => {
			const sweep = (item / total) * Math.PI * 2;
			const start = angle;
			angle += sweep;
			const point = (at: number, r: number) => `${r * Math.cos(at)} ${r * Math.sin(at)}`;
			const inner = radius * 0.58;
			const large = sweep > Math.PI ? 1 : 0;
			// A whole circle is two half arcs: one arc from a point back to itself draws nothing.
			const path =
				sweep >= Math.PI * 2 - 1e-6
					? `M ${point(start, radius)} A ${radius} ${radius} 0 1 1 ${point(start + Math.PI, radius)} A ${radius} ${radius} 0 1 1 ${point(start, radius)} M ${point(start, inner)} A ${inner} ${inner} 0 1 0 ${point(start + Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${point(start, inner)} Z`
					: `M ${point(start, radius)} A ${radius} ${radius} 0 ${large} 1 ${point(angle, radius)} L ${point(angle, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`;
			return { path, index };
		});
		const focus = hover ?? null;
		return (
			<figure className="ly-ui-chart m-0 flex min-w-0 flex-wrap items-center gap-4">
				<svg width={height} height={height} viewBox={`${-height / 2} ${-height / 2} ${height} ${height}`} role="img" aria-label={labels.map((label, index) => `${label} ${values[index]}`).join(", ")}>
					{slices.map((slice) => (
						<path
							key={slice.index}
							d={slice.path}
							fill={colour(slice.index)}
							fillRule="evenodd"
							opacity={focus === null || focus === slice.index ? 1 : 0.35}
							className="transition-opacity duration-[var(--ly-t-quick)]"
							onPointerEnter={() => setHover(slice.index)}
							onPointerLeave={() => setHover(null)}
						/>
					))}
					<text textAnchor="middle" dominantBaseline="central" style={{ fill: "var(--color-ink)", fontSize: "var(--text-label)" }}>
						{focus === null ? `${short(total)}${unit ?? ""}` : `${Math.round((values[focus]! / total) * 100)}%`}
					</text>
				</svg>
				<div className="min-w-0 flex-1 basis-40">
					<Legend names={labels} unit={unit} totals={values} />
				</div>
			</figure>
		);
	}

	const all = rows.flatMap((row) => keys.map((name) => value(row, name)));
	const marks = ticks(Math.min(0, ...all), Math.max(0, ...all));
	const low = marks[0]!;
	const high = marks.at(-1)!;
	const gutter = Math.max(...marks.map((mark) => `${short(mark)}${unit ?? ""}`.length)) * 7 + 10;
	const plot = { left: gutter, right: Math.max(gutter + 1, width - 8), top: 8, bottom: height - 22 };
	const span = plot.right - plot.left;
	const step = span / rows.length;
	const yAt = (number: number) => plot.bottom - ((number - low) / (high - low || 1)) * (plot.bottom - plot.top);
	const xAt = (index: number) => (kind === "bar" ? plot.left + step * (index + 0.5) : plot.left + (rows.length === 1 ? span / 2 : (index / (rows.length - 1)) * span));
	// Every label that fits, evenly: 56px a label is where they stop touching.
	const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(span / 56))));
	const point = (event: PointerEvent<SVGRectElement>) => {
		const left = event.currentTarget.getBoundingClientRect().left;
		const at = kind === "bar" ? Math.floor((event.clientX - left) / step) : Math.round(((event.clientX - left) / span) * (rows.length - 1));
		setHover(Math.min(rows.length - 1, Math.max(0, at)));
	};
	const tipLeft = hover === null ? 0 : Math.min(Math.max(xAt(hover) + 10, 0), Math.max(0, width - 160));

	return (
		<figure className="ly-ui-chart m-0 flex min-w-0 flex-col gap-2">
			<div ref={box} className="relative min-w-0" style={{ height }}>
				{width > 0 && (
					<svg width={width} height={height} role="img" aria-label={`${keys.join(", ")}: ${labels.join(", ")}`} className="block overflow-visible">
						{marks.map((mark) => (
							<g key={mark}>
								<line x1={plot.left} x2={plot.right} y1={yAt(mark)} y2={yAt(mark)} stroke="var(--color-line-soft)" strokeDasharray={mark === 0 ? undefined : "2 3"} />
								<text x={plot.left - 6} y={yAt(mark)} textAnchor="end" dominantBaseline="central">{`${short(mark)}${unit ?? ""}`}</text>
							</g>
						))}
						{labels.map((label, index) =>
							index % every === 0 ? (
								<text key={index} x={xAt(index)} y={height - 6} textAnchor="middle">
									{label.length > 10 ? `${label.slice(0, 9)}…` : label}
								</text>
							) : null,
						)}
						{hover !== null && kind !== "bar" && <line x1={xAt(hover)} x2={xAt(hover)} y1={plot.top} y2={plot.bottom} stroke="var(--color-line)" />}
						{kind === "bar"
							? rows.map((row, index) => {
									const band = step * 0.72;
									const each = band / keys.length;
									return keys.map((name, at) => {
										const amount = value(row, name);
										const top = yAt(Math.max(0, amount));
										return (
											<rect
												key={`${index}-${at}`}
												x={plot.left + step * index + (step - band) / 2 + each * at}
												y={top}
												width={Math.max(1, each - (keys.length > 1 ? 2 : 0))}
												height={Math.max(0, Math.abs(yAt(amount) - yAt(0)))}
												rx={Math.min(3, each / 4)}
												fill={colour(at)}
												opacity={hover === null || hover === index ? 1 : 0.45}
											/>
										);
									});
								})
							: keys.map((name, at) => {
									const points = rows.map((row, index) => `${xAt(index)},${yAt(value(row, name))}`);
									return (
										<g key={name}>
											{kind === "area" && <path d={`M ${xAt(0)},${yAt(Math.max(low, 0))} L ${points.join(" L ")} L ${xAt(rows.length - 1)},${yAt(Math.max(low, 0))} Z`} fill={colour(at)} opacity={0.16} />}
											<polyline points={points.join(" ")} fill="none" stroke={colour(at)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
											{hover !== null && <circle cx={xAt(hover)} cy={yAt(value(rows[hover]!, name))} r={3.5} fill={colour(at)} />}
										</g>
									);
								})}
						<rect x={plot.left} y={plot.top} width={span} height={plot.bottom - plot.top} fill="transparent" onPointerMove={point} onPointerLeave={() => setHover(null)} />
					</svg>
				)}
				{hover !== null && (
					<div className="ly-glass-solid pointer-events-none absolute top-1 z-10 min-w-[120px] rounded-lg px-2 py-1.5 text-caption" style={{ left: tipLeft }}>
						<div className="mb-0.5 text-ink">{labels[hover]}</div>
						{keys.map((name, at) => (
							<div key={name} className="flex items-center justify-between gap-3 text-ink-muted">
								<span className="inline-flex items-center gap-1.5">
									<span className="h-2 w-2 rounded-sm" style={{ background: colour(at) }} />
									{name}
								</span>
								<span className="text-ink tabular-nums">{`${text(rows[hover]![name])}${unit ?? ""}`}</span>
							</div>
						))}
					</div>
				)}
			</div>
			{keys.length > 1 && <Legend names={keys} />}
		</figure>
	);
}
