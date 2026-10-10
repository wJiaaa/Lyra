/**
 * The parts of an interface block that arrange and show: layout, text, figures, tables.
 *
 * Drawn with the app's own tokens — type steps, lines, card surfaces — so a block reads as part of
 * the reply rather than a page pasted into it. Sizes are the app's steps, never the model's pixels.
 */

import type { ReactNode } from "react";
import { text } from "@plume/core/ui-language";
import { TabStrip } from "../../../ui/primitives/TabStrip.tsx";
import { MarkdownTable } from "../MarkdownTable.tsx";

export type Tone = "info" | "ok" | "warning" | "danger";

export function Stack({ gap, children }: { gap?: string; children: ReactNode }) {
	return (
		<div data-gap={gap ?? "md"} className="flex min-w-0 flex-col gap-[var(--ly-ui-gap)]">
			{children}
		</div>
	);
}

const JUSTIFY: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" };

export function Row({ gap, align, children }: { gap?: string; align?: string; children: ReactNode }) {
	return (
		<div data-gap={gap ?? "md"} className={`ly-ui-row flex min-w-0 flex-wrap items-center gap-[var(--ly-ui-gap)] ${JUSTIFY[align ?? "start"] ?? ""}`}>
			{children}
		</div>
	);
}

export function Grid({ cols, gap, children }: { cols?: number; gap?: string; children: ReactNode }) {
	const count = Math.min(6, Math.max(1, Math.round(cols ?? 3)));
	return (
		<div data-gap={gap ?? "md"} className="ly-ui-grid min-w-0" style={{ "--ly-ui-cols": count } as React.CSSProperties}>
			{children}
		</div>
	);
}

/**
 * A card, or — inside another card — a section of it. The outer card already lifts the block off
 * the reply; a second frame inside it would be a card floating on a card.
 */
export function Card({ title, subtitle, nested, children }: { title?: string; subtitle?: string; nested: boolean; children: ReactNode }) {
	return (
		<section className={`flex min-w-0 flex-col gap-[var(--ly-ui-gap)] ${nested ? "rounded-lg bg-card/50 p-3" : "rounded-xl border border-line bg-card/30 p-4"}`}>
			{(title || subtitle) && (
				<header className="flex flex-col gap-0.5">
					{title && <div className="text-label font-semibold text-ink">{title}</div>}
					{subtitle && <div className="text-caption text-ink-muted">{subtitle}</div>}
				</header>
			)}
			{children}
		</section>
	);
}

export function Divider() {
	return <div role="separator" className="h-px shrink-0 bg-line" />;
}

/** `value` unset or not one of the titles opens the first. */
export function Tabs({ titles, value, onChange, render }: { titles: string[]; value?: string; onChange: (title: string) => void; render: (at: number) => ReactNode }) {
	const at = Math.max(0, titles.indexOf(value ?? ""));
	if (!titles.length) return null;
	return (
		<div className="flex min-w-0 flex-col gap-[var(--ly-ui-gap)]">
			<TabStrip items={titles.map((title) => ({ id: title, label: title }))} value={titles[at]!} onChange={onChange} label={titles.join(" / ")} className="self-start" />
			{render(at)}
		</div>
	);
}

const HEADING = ["text-title font-semibold", "text-label font-semibold", "text-caption font-medium text-ink-muted"];

export function Heading({ level, children }: { level?: number; children: ReactNode }) {
	const step = Math.min(3, Math.max(1, Math.round(level ?? 2)));
	return (
		<div role="heading" aria-level={step + 1} className={`text-ink ${HEADING[step - 1]}`}>
			{children}
		</div>
	);
}

const SIZE: Record<string, string> = { sm: "text-caption", md: "text-label", lg: "text-title" };

/** `Text`, and with `badge` a `Badge`: the same words in a smaller, tinted capsule. */
export function Words({ tone, size, badge, children }: { tone?: string; size?: string; badge?: boolean; children: ReactNode }) {
	const toned = tone && tone !== "muted" && tone !== "strong";
	if (badge)
		return (
			<span
				className={`inline-flex w-fit items-center rounded-md px-1.5 py-0.5 text-caption ${
					toned ? `ly-ui-tone-${tone} bg-[color-mix(in_srgb,var(--ly-ui-tone)_15%,transparent)] text-[var(--ly-ui-tone)]` : "bg-card text-ink-muted"
				}`}
			>
				{children}
			</span>
		);
	const colour = tone === "muted" ? "text-ink-muted" : tone === "strong" ? "font-medium text-ink" : toned ? `ly-ui-tone-${tone} text-[var(--ly-ui-tone)]` : "text-ink";
	return <p className={`m-0 min-w-0 whitespace-pre-wrap ${SIZE[size ?? "md"] ?? "text-label"} ${colour}`}>{children}</p>;
}

export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
	return (
		<div className={`ly-ui-tone-${tone} flex flex-col gap-1 rounded-lg border-l-2 border-[var(--ly-ui-tone)] bg-[color-mix(in_srgb,var(--ly-ui-tone)_7%,transparent)] px-3 py-2 text-label`}>
			{title && <div className="font-medium text-[var(--ly-ui-tone)]">{title}</div>}
			<div className="flex flex-col gap-1 text-ink">{children}</div>
		</div>
	);
}

/** `+12%` and `−3` say which way on their own; anything else is shown as written, uncoloured. */
function direction(delta: string): "up" | "down" | null {
	const lead = delta.trim()[0];
	return lead === "+" || lead === "↑" ? "up" : lead === "-" || lead === "−" || lead === "↓" ? "down" : null;
}

export function Stat({ label, value, delta, hint }: { label?: string; value: unknown; delta?: unknown; hint?: string }) {
	const change = delta === undefined ? "" : typeof delta === "number" ? `${delta > 0 ? "+" : ""}${delta}` : text(delta);
	const way = change ? direction(change) : null;
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<div className="truncate text-caption text-ink-muted">{label}</div>
			<div className="flex flex-wrap items-baseline gap-x-2">
				<span className="text-heading font-semibold text-ink tabular-nums">{text(value)}</span>
				{change && <span className={`text-caption tabular-nums ${way === "up" ? "text-ok" : way === "down" ? "text-danger" : "text-ink-muted"}`}>{change}</span>}
			</div>
			{hint && <div className="text-caption text-ink-faint">{hint}</div>}
		</div>
	);
}

export function Progress({ value, max, label, tone }: { value?: number; max?: number; label?: string; tone?: Tone }) {
	const whole = max && max > 0 ? max : 100;
	const share = Math.min(1, Math.max(0, (value ?? 0) / whole));
	return (
		<div className={`flex flex-col gap-1 ${tone ? `ly-ui-tone-${tone}` : "ly-ui-tone-accent"}`}>
			<div className="flex items-baseline justify-between gap-3 text-caption">
				<span className="truncate text-ink-muted">{label}</span>
				<span className="text-ink tabular-nums">{Math.round(share * 100)}%</span>
			</div>
			<div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={whole} aria-valuenow={value ?? 0} className="h-1.5 overflow-hidden rounded-full bg-line">
				<div className="h-full rounded-full bg-[var(--ly-ui-tone)] transition-[width] duration-[var(--ly-t-base)]" style={{ width: `${share * 100}%` }} />
			</div>
		</div>
	);
}

/** Rows of arrays with their columns, or rows of objects whose keys are the columns — both drawn as the reply's own tables. */
export function Table({ columns, rows, data }: { columns?: unknown[]; rows?: unknown[]; data?: unknown[] }) {
	const records = (data ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
	const header = (columns ?? (records[0] ? Object.keys(records[0]) : [])).map(text);
	const cells: unknown[][] = rows ? rows.map((row) => (Array.isArray(row) ? row : [row])) : records.map((record) => header.map((key) => record[key]));
	if (!header.length && !cells.length) return null;
	const width = Math.max(header.length, ...cells.map((row) => row.length));
	// Figures to the right, as in any table of numbers: a column is numeric when every filled cell is.
	const align = Array.from({ length: width }, (_, at) => (cells.length && cells.every((row) => row[at] === undefined || row[at] === "" || typeof row[at] === "number") ? ("right" as const) : ("left" as const)));
	return (
		<MarkdownTable
			block={{
				kind: "table",
				header: Array.from({ length: width }, (_, at) => header[at] ?? ""),
				rows: cells.map((row) => Array.from({ length: width }, (_, at) => text(row[at]))),
				align,
			}}
			inline={(cell) => cell}
		/>
	);
}
