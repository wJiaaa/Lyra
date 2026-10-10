/**
 * 界面块在手机上怎么排：网格几列、表格的格子、图表画成哪几根条。没有 React，测试直接跑。
 *
 * 读块的规则（哪些行算数、哪个键是标签、哪些是序列）是语言本身的，从 `ui-language` 来，和桌面一份；
 * 这里只管手机屏幕上的取舍。
 */

import { chartData, chartValue, text } from "@plume/client-runtime/ui-language";

/**
 * 一格最窄多宽。桌面是 9.5rem（152）；手机卡片里只剩 300 来宽，照搬 152 每个网格都成了一列，
 * 三个并排的数字摞成一长条。132 放得下一个 22px 的数加上它的涨跌，360 宽的手机也能两列。
 */
const MIN_COLUMN = 132;

/** `cols` 是上限：屏幕放不下就少几列，和桌面同一条规则。 */
export function gridColumns(cols: number | undefined, width: number, gap: number): number {
	const wanted = Math.min(6, Math.max(1, Math.round(cols ?? 3)));
	return Math.max(1, Math.min(wanted, Math.floor((width + gap) / (MIN_COLUMN + gap))));
}

export interface TableData {
	header: string[];
	rows: string[][];
	/** 每一列是不是数字列：数字靠右，和桌面一样。 */
	numeric: boolean[];
}

/** `rows` 配 `columns`，或 `data` 的每一项是一行、键是列——和桌面 `Table` 同一种读法。 */
export function tableOf(columns?: unknown[], rows?: unknown[], data?: unknown[]): TableData | null {
	const records = (data ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
	const header = (columns ?? (records[0] ? Object.keys(records[0]) : [])).map(text);
	const cells: unknown[][] = rows ? rows.map((row) => (Array.isArray(row) ? row : [row])) : records.map((record) => header.map((key) => record[key]));
	if (!header.length && !cells.length) return null;
	const width = Math.max(header.length, ...cells.map((row) => row.length));
	return {
		header: Array.from({ length: width }, (_, at) => header[at] ?? ""),
		rows: cells.map((row) => Array.from({ length: width }, (_, at) => text(row[at]))),
		numeric: Array.from({ length: width }, (_, at) => cells.length > 0 && cells.every((row) => row[at] === undefined || row[at] === "" || typeof row[at] === "number")),
	};
}

/**
 * 表格写成 markdown，交给回复自己的表格去画：界面块里的表和回复里的表在手机上是同一种样子。
 * 格子里是数据不是 markdown，标记字符都转义掉，`a*b*c` 不会变成斜体。
 */
export function tableMarkdown(table: TableData): string {
	const cell = (value: string) => value.replace(/\s*\n\s*/g, " ").replace(/[\\`*_[\]<>|~#]/g, "\\$&") || " ";
	const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
	return [line(table.header), `|${table.numeric.map((right) => (right ? " ---: " : " --- ")).join("|")}|`, ...table.rows.map(line)].join("\n");
}

/**
 * 手机上不画 SVG（没有这个依赖），一个序列画成横条：一行一根，标签和数在条上方。
 * 折线和面积图也这样画——几十个点以内，横条读得出高低；饼图的条按占总数的比例，数后面带百分比。
 * 多个序列、或者点多到一屏放不下，横条读不出来，改画成表。
 */
export const MAX_BARS = 24;

interface Bar {
	label: string;
	value: number;
	/** 条的长度，0–1。 */
	length: number;
	/** 饼图：占总数多少，0–1。 */
	share?: number;
}

export type ChartView = { kind: "bars"; series: string; bars: Bar[] } | { kind: "table"; table: TableData } | null;

export function chartView(kind: string | undefined, data: unknown[] | undefined, x: string | undefined, y: unknown): ChartView {
	const { rows, labels, keys } = chartData(data, x, y);
	if (!rows.length || !keys.length) return null;
	if (keys.length === 1 && rows.length <= MAX_BARS) {
		const pie = kind === "pie";
		const values = rows.map((row) => (pie ? Math.max(0, chartValue(row, keys[0]!)) : chartValue(row, keys[0]!)));
		const top = Math.max(...values.map(Math.abs)) || 1;
		const total = values.reduce((sum, value) => sum + value, 0) || 1;
		return { kind: "bars", series: keys[0]!, bars: values.map((value, at) => ({ label: labels[at]!, value, length: Math.abs(value) / top, ...(pie ? { share: value / total } : {}) })) };
	}
	return {
		kind: "table",
		table: { header: ["", ...keys], rows: rows.map((row, at) => [labels[at]!, ...keys.map((key) => text(row[key]))]), numeric: [false, ...keys.map(() => true)] },
	};
}
