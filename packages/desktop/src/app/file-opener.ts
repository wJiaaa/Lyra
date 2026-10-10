/**
 * Open a file in a screen's file pane — what a local link in a reply does.
 *
 * Registered by the dock, which owns the panes. Kept apart for the same reason as `focusScreen` in
 * `session-scope.tsx`: a generated image's menu lives in the conversation, the dock draws the
 * conversation, and importing the dock from there would close a loop. A `.ts` file of its own
 * because `popout.ts` registers it and the node tests load that file, which cannot import `.tsx`.
 */
let fileOpener: ((path: string, screen?: string) => Promise<void>) | null = null;

export function provideFileOpener(open: typeof fileOpener): void {
	fileOpener = open;
}

export function openFileInScreen(path: string, screen?: string): Promise<void> {
	return fileOpener?.(path, screen) ?? Promise.resolve();
}
