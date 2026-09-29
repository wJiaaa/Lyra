/**
 * Where the application icon file can be, packaged or not.
 *
 * Split out of `window.ts` so the packaged answer can be checked against `electron-builder.yml`
 * without Electron. It used to be a list of six guesses that were all wrong in a release:
 * `build/icon.png` was not in `files` or `extraResources`, so nothing put it anywhere, and
 * `appIconPath()` was undefined in every package ever built. Windows and Linux windows had no
 * icon of their own, and neither did their notifications.
 */

import { join } from "node:path";

export interface IconLocation {
	platform: string;
	packaged: boolean;
	/** `app.getAppPath()`: the source package in development, `…/resources/app.asar` packaged. */
	appPath: string;
	/** `process.resourcesPath`. */
	resourcesPath: string;
	/** The directory of the running main bundle, `out/main`. */
	moduleDir: string;
}

export function appIconCandidates(where: IconLocation): string[] {
	/*
	 * macOS: none, packaged or not. The bundle's icon is what the app switcher and notifications
	 * already use — in development too, where `brand-dev-electron.mjs` gives the Electron bundle the
	 * same `Assets.car` — and a PNG handed to a notification would replace it with the bare cut-out.
	 * The dock is the one place the app overrides it, with `dockIconCandidates` below.
	 */
	if (where.platform === "darwin") return [];
	return resourceCandidates(where, "icon.png");
}

/**
 * The macOS dock icon for the current theme, made by `scripts/make-dock-icons.mjs`.
 *
 * The bundle icon's dark variant only shows when the system's "icon & widget style" is Dark —
 * light or dark mode alone does not switch it — so the running app sets the dock icon itself.
 */
export function dockIconCandidates(where: IconLocation, dark: boolean): string[] {
	return resourceCandidates(where, dark ? "dock-dark.png" : "dock-light.png");
}

function resourceCandidates(where: IconLocation, file: string): string[] {
	if (where.packaged) {
		// Exactly where the `extraResources` entry for `build/<file>` puts it.
		return [join(where.resourcesPath, "build", file)];
	}
	return [
		join(where.appPath, "build", file),
		join(where.appPath, "..", "build", file),
		join(where.appPath, "packages", "desktop", "build", file),
		join(where.moduleDir, "..", "..", "build", file),
	];
}
