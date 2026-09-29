/**
 * The two dock icons the running app switches between, rendered from `build/icon.icon`.
 *
 * macOS picks the bundle icon's variant from its own "icon & widget style" setting, not from light
 * or dark mode, so while the app runs it sets the dock icon itself to follow the theme (`main.ts`).
 * These are the Icon Composer document's Default and Dark renditions, drawn at 824 px and centred
 * on a 1024 canvas — Apple's icon grid, so they sit the same size as every other icon in the dock.
 *
 * Run with `pnpm dock:icons` after changing `icon.icon`. Needs Xcode 26+ for `ictool`. The output
 * is committed, like the tray icons: nothing at build or run time should depend on regenerating it.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const build = join(dirname(dirname(fileURLToPath(import.meta.url))), "build");
const ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";

for (const [rendition, file] of [
	["Default", "dock-light.png"],
	["Dark", "dock-dark.png"],
]) {
	const out = join(build, file);
	execFileSync(ICTOOL, [
		join(build, "icon.icon"),
		"--export-image",
		"--output-file",
		out,
		"--platform",
		"macOS",
		"--rendition",
		rendition,
		"--width",
		"824",
		"--height",
		"824",
		"--scale",
		"1",
	]);
	// Pads with transparency, keeping the squircle centred.
	execFileSync("sips", ["--padToHeightWidth", "1024", "1024", out, "--out", out], { stdio: "ignore" });
	console.log(`[dock] ${file}`);
}
