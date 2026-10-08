/**
 * Match a control by the name a person would use.
 *
 * After the icon-button pass, many faces have no visible word — the name lives on
 * `aria-label` / `data-ly-tip`. Tests that still read `textContent` time out on a
 * button that is there and labelled. This expression is injected into the page.
 */

export type NamedMode = "exact" | "starts" | "includes" | "stripCount";

/** A JS predicate for `evaluate` strings. `el` is the element identifier in that page. */
export function named(text: string, mode: NamedMode = "exact", el = "e"): string {
	const needle = JSON.stringify(text);
	const visible = mode === "stripCount"
		? `(${el}.textContent||"").trim().replace(/\\s*\\d+$/, "")`
		: `(${el}.textContent||"").trim()`;
	const aria = `(${el}.getAttribute("aria-label")||"").trim()`;
	const tip = `(${el}.dataset.lyTip||"").trim()`;
	// 同一种行出现好几次、名字里只有中间那一段能区分它们时用（比如两轮各有一行「已工作 …」）。
	if (mode === "includes") {
		return `(${visible}.includes(${needle})||${aria}.includes(${needle})||${tip}.includes(${needle}))`;
	}
	if (mode === "starts") {
		return `(${visible}.startsWith(${needle})||${aria}.startsWith(${needle})||${tip}.startsWith(${needle}))`;
	}
	return `(${visible}===${needle}||${aria}===${needle}||${tip}===${needle})`;
}
