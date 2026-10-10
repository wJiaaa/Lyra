/**
 * The interface-block language, for whatever draws it: browser-safe, no imports outside this folder.
 *
 * The desktop renders from these so it agrees with the prompt and the check about every rule. What
 * only the runtime needs — the prompt section, the notes on the next turn — is not exported here.
 */

export { chartData, chartValue, MAX_CHART_POINTS, type ChartData, type ChartRow } from "./chart.ts";
export { COMMON_PROPS, COMPONENTS, type ComponentSpec, type PropSpec } from "./catalog.ts";
export { checkBlock, initialState, readProps, templateParts } from "./check.ts";
export { evaluate, text, type Expression } from "./expression.ts";
export { parseBlock, type ParsedBlock, type PropValue, type TextPart, type UiElement, type UiNode, type UiText } from "./parse.ts";
