/**
 * Which host this renderer is running in, and what that host can do.
 *
 * The same bundle runs in an Electron window and in a WebView on a phone. In the window every
 * method answers; on the phone only the ones `@plume/contract` marks as `remote` do, and the rest
 * are absent — `mobile/src/bridge.ts` fills them with a function that rejects.
 *
 * Before this file, four components asked `window.plume?.host === "mobile"` and each drew its own
 * conclusion. The problem with that is not the repetition, it is that no single place could answer
 * "what is broken on a phone" — and the failure mode is silent: a button that is there, does
 * nothing, and reports nothing.
 */

import { methodFor } from "@plume/contract";


type Host = "desktop" | "mobile";

/** Where this renderer is being displayed. Desktop unless the bridge says otherwise. */
function host(): Host {
	// Both spellings, for the same reason as `bridge.ts`.
	const scope = globalThis as { plume?: { host?: Host }; window?: { plume?: { host?: Host } } };
	return (scope.plume ?? scope.window?.plume)?.host ?? "desktop";
}

/** True when the interface is being shown through a phone rather than in a window. */
export function onPhone(): boolean {
	return host() === "mobile";
}

/**
 * Which system the desktop runs — the one whose files, bin and file manager these are, which on a
 * phone is the paired desktop's rather than the phone's own.
 *
 * Read the way `host()` reads, without going through `bridge`: that throws when there is no
 * bridge, and the words that depend on this are drawn during render, where a label is not worth
 * taking the whole tree down for. macOS when nothing says otherwise, as the window chrome assumes.
 */
export function hostPlatform(): string {
	const scope = globalThis as { plume?: { platform?: string }; window?: { plume?: { platform?: string } } };
	return (scope.plume ?? scope.window?.plume)?.platform ?? "darwin";
}

/**
 * Whether a method answers in this host.
 *
 * Answered from the contract rather than by probing the object, so a component can ask *before*
 * drawing a control rather than after a call has failed. `available("terminal", "open")` is false
 * on a phone because the contract says a shell is not something a pairing token should confer.
 *
 * Unknown methods answer `false`: a name that is not in the contract does not exist anywhere, and
 * saying "sure, try it" about a typo helps nobody.
 */
export function available(group: string, method: string): boolean {
	const entry = methodFor(`${group}.${method}`);
	if (!entry) return false;
	return host() === "desktop" || entry.remote;
}
