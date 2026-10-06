/**
 * What the renderer knows about the machine it is running on, read without going through `bridge`.
 */

/**
 * Which system the desktop runs — the one whose files, bin and file manager these are.
 *
 * Read straight off `window.plume` rather than through `bridge`: that throws when there is no
 * bridge, and the words that depend on this are drawn during render, where a label is not worth
 * taking the whole tree down for. macOS when nothing says otherwise, as the window chrome assumes.
 */
export function hostPlatform(): string {
	// Both spellings, for the same reason as `bridge.ts`.
	const scope = globalThis as { plume?: { platform?: string }; window?: { plume?: { platform?: string } } };
	return (scope.plume ?? scope.window?.plume)?.platform ?? "darwin";
}
