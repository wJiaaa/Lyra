/**
 * What the renderer knows about where it is running, read without going through `bridge`.
 *
 * The same bundle runs in two places. In an Electron window every method answers; in a browser
 * that opened it through Web access only the ones `@lyra/contract` lists in `WEB_METHODS` do —
 * the desktop refuses the rest, and `web-bridge.ts` answers them with nothing. So a component that
 * would draw a control for a method that cannot answer asks `available()` first, rather than
 * drawing a button that does nothing and reports nothing.
 */

import { METHODS, WEB_METHODS } from "@lyra/contract";

type Host = "desktop" | "web";

/** Both spellings, for the same reason as `bridge.ts`. */
function lyra(): { host?: Host; platform?: string } | undefined {
	const scope = globalThis as { lyra?: { host?: Host; platform?: string }; window?: { lyra?: { host?: Host; platform?: string } } };
	return scope.lyra ?? scope.window?.lyra;
}

/** True when this interface is being shown in a browser through Web access rather than in a window. */
export function onWeb(): boolean {
	return lyra()?.host === "web";
}

/**
 * Which system the desktop runs — the one whose files, bin and file manager these are.
 *
 * Read straight off `window.lyra` rather than through `bridge`: that throws when there is no
 * bridge, and the words that depend on this are drawn during render, where a label is not worth
 * taking the whole tree down for. macOS when nothing says otherwise, as the window chrome assumes.
 */
export function hostPlatform(): string {
	return lyra()?.platform ?? "darwin";
}

/**
 * Whether a method answers in this host.
 *
 * Answered from the contract rather than by probing the object, so a component can ask *before*
 * drawing a control rather than after a call has failed. Unknown methods answer `false`: a name that
 * is not in the contract does not exist anywhere, and saying "sure, try it" about a typo helps
 * nobody.
 */
export function available(group: string, method: string): boolean {
	const methods = (METHODS as Record<string, Record<string, unknown> | undefined>)[group];
	if (!methods || !Object.hasOwn(methods, method)) return false;
	return !onWeb() || WEB_METHODS.has(`${group}.${method}`);
}
