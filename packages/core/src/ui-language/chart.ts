/**
 * How a `Chart` reads its data: which rows count, which key labels them, which keys are series.
 *
 * Part of the language, not of a drawing: the prompt teaches "x is the label key, y one key or a
 * list (default: every numeric key)", and every place that draws a chart — the desktop's SVG, the
 * phone's bars — has to read the same block into the same rows. Two copies of this would be the
 * drift `catalog.ts` exists to prevent.
 *
 * The data is the model's, so nothing is assumed of it: rows that are not objects are skipped,
 * values that are not numbers count as nothing.
 */

import { text } from "./expression.ts";

/** More than a chart can show apart; the rest is a table's job. */
export const MAX_CHART_POINTS = 500;

export type ChartRow = Record<string, unknown>;

export function chartValue(row: ChartRow, key: string): number {
	const raw = row[key];
	const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,\s]/g, "")) : Number.NaN;
	return Number.isFinite(number) ? number : 0;
}

export interface ChartData {
	rows: ChartRow[];
	/** One per row: the label key's value, or the row's number when there is no label key. */
	labels: string[];
	/** The series, in order. */
	keys: string[];
}

export function chartData(data: unknown[] | undefined, x: string | undefined, y: unknown): ChartData {
	const rows = (data ?? []).filter((row): row is ChartRow => Boolean(row) && typeof row === "object" && !Array.isArray(row)).slice(0, MAX_CHART_POINTS);
	const first = rows[0] ?? {};
	const key = x || (Object.keys(first).find((name) => typeof first[name] === "string") ?? null);
	const named = typeof y === "string" ? [y] : Array.isArray(y) ? y.map(text) : null;
	const keys = named ? named.filter(Boolean) : Object.keys(first).filter((name) => name !== key && typeof first[name] === "number");
	return { rows, labels: rows.map((row, index) => (key ? text(row[key]) : String(index + 1))), keys };
}
