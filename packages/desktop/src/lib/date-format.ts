/**
 * `toLocaleString(locale, options)`, with the formatter kept.
 *
 * Every call with options builds a fresh `Intl.DateTimeFormat` — about 30µs here, against 7µs for
 * reusing one. That is nothing once; it is the bulk of a sidebar render, where each of eighty rows
 * formats its tooltip, and the transcript does the same for every message's caption. Kept per
 * language and shape, and both only ever take a handful of values.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

export function formatDate(at: Date | number, locale: string, options: Intl.DateTimeFormatOptions): string {
	const key = `${locale}|${JSON.stringify(options)}`;
	let format = formats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, options);
		formats.set(key, format);
	}
	return format.format(at);
}
