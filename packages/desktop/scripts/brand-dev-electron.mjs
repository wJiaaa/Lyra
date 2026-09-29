/**
 * Make the development app say "Plume" instead of "Electron".
 *
 * Packaged builds never come through here — electron-builder writes productName into the bundle.
 * This is only about development, where the process being run is Electron's own prebuilt
 * `Electron.app`, and where the dock, ⌘-tab, Finder and the force-quit list all read that
 * bundle's identity. `app.setName()` cannot reach any of it: it changes `app.getName()` and the
 * userData path, and the window server has already read the bundle by the time JavaScript exists.
 *
 * Four things carry the name, and the dock falls back through all of them. Changing only the
 * plist changes nothing visible, which is exactly what it looked like for several attempts:
 *
 *   1. `CFBundleName` / `CFBundleDisplayName` — the answer when the app is launched properly.
 *   2. `CFBundleIdentifier` — still `com.github.Electron` means the dock matches the long-standing
 *      "Electron" record already in LaunchServices, and shows our icon under that name.
 *   3. The executable's filename — development runs the binary directly rather than through
 *      `open -a`, so LaunchServices never registers it as a launched application and the dock
 *      falls back to the process name, which comes from argv[0].
 *   4. The `.app` directory name — the last fallback, and the one VS Code also changes (they
 *      ship `Code - OSS.app`).
 *
 * Then LaunchServices caches the result by path, and the Dock caches it again on top of that.
 *
 * All of it is confined to this repository's `node_modules` copy — no global pnpm store is
 * touched — and `--restore` puts every piece back. Reinstalling `electron` also restores it,
 * and the script runs again from `postinstall`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "Plume";
/** Matches `appId` in electron-builder.yml, so development and release are one identity. */
const APP_ID = "dev.plume.app";
const LSREGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/*
 * Packaging has to run this first with `--restore`.
 *
 * electron-builder builds a macOS app by copying `dist/Electron.app` out of node_modules and
 * renaming it. It looks for that exact name, so a renamed bundle fails the build outright — and
 * it fails per-architecture, which is the kind of thing that passes locally on arm64 and breaks
 * the x64 job. Development polish is never worth a broken artifact.
 */
const restore = process.argv.includes("--restore");

if (process.platform !== "darwin") process.exit(0);

const require = createRequire(import.meta.url);

/** pnpm links `electron` into place, so resolve the entry and work down from the real package. */
let bundle;
try {
	const dist = join(dirname(require.resolve("electron")), "dist");
	// Either name may be on disk, depending on whether this has run before.
	bundle = existsSync(join(dist, `${NAME}.app`)) ? join(dist, `${NAME}.app`) : join(dist, "Electron.app");
} catch {
	// Not installed yet — postinstall ordering, or a CI job that never launches it.
	process.exit(0);
}

const plist = join(bundle, "Contents", "Info.plist");
if (!existsSync(plist)) process.exit(0);

const read = (key) => {
	try {
		// stderr is silenced: a key that is not there yet is an answer here, not an error.
		return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
};

const set = (key, value) => {
	try {
		execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "ignore" });
	} catch {
		try {
			execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
		} catch {
			// A read-only store, or a plist shape we do not recognise. The name is cosmetic and
			// must never be the reason the app will not start.
		}
	}
};

const remove = (key) => {
	try {
		execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
	} catch {
		// Already absent.
	}
};

// The dock icon comes from the bundle too, and Electron's default is its own atom.
const icon = join(dirname(dirname(fileURLToPath(import.meta.url))), "build", "icon.icns");
const iconTarget = join(bundle, "Contents", "Resources", "electron.icns");

/*
 * Compared by content, not by whether the bundle was ever branded: `build/icon.icns` changes on
 * its own, and an already-branded copy would otherwise keep the old icon until `electron` is
 * reinstalled.
 */
const iconStale =
	existsSync(icon) && existsSync(iconTarget) && !readFileSync(icon).equals(readFileSync(iconTarget));

/*
 * The icon that follows light and dark mode.
 *
 * An `.icns` holds one picture. The appearance variants exist only in the asset catalog `actool`
 * compiles from the Icon Composer document, and macOS reads it only when `CFBundleIconName` names
 * it — the same two things electron-builder puts into a packaged bundle. `actool` output is not
 * byte-for-byte reproducible, so staleness is a digest of the document, kept in the plist.
 */
const iconDocument = join(dirname(icon), "icon.icon");
const DIGEST_KEY = "PlumeIconDigest";
const iconDigest = existsSync(iconDocument)
	? readdirSync(iconDocument, { recursive: true })
			.map(String)
			.sort()
			.filter((file) => statSync(join(iconDocument, file)).isFile())
			.reduce((hash, file) => hash.update(file).update(readFileSync(join(iconDocument, file))), createHash("sha256"))
			.digest("hex")
	: "";
const assetsStale = iconDigest !== "" && read(DIGEST_KEY) !== iconDigest;

/** Re-signing the bundle takes seconds, so nothing below runs on an already-branded copy. */
const done =
	bundle.endsWith(`${NAME}.app`) &&
	read("CFBundleName") === NAME &&
	read("CFBundleExecutable") === NAME &&
	read("CFBundleIdentifier") === APP_ID &&
	!iconStale &&
	!assetsStale;

if (!restore && done) process.exit(0);

const sign = () => {
	try {
		// Required: macOS checks the bundle against its signature, and an edited Info.plist
		// without a re-sign is an app that will not launch at all.
		execFileSync("codesign", ["--force", "--sign", "-", "--deep", bundle], { stdio: "ignore" });
	} catch {
		// Missing codesign is rare, and an ad-hoc signature is not strictly required to run.
	}
};

const pathFileFor = (app) => resolve(app, "..", "..", "path.txt");

if (restore) {
	const macOS = join(bundle, "Contents", "MacOS");
	const renamed = join(macOS, NAME);
	const original = join(macOS, "Electron");
	if (existsSync(renamed)) {
		// The compatibility symlink sits at the original name; drop it before moving the binary back.
		if (existsSync(original)) rmSync(original);
		renameSync(renamed, original);
	}
	set("CFBundleExecutable", "Electron");
	set("CFBundleIdentifier", "com.github.Electron");
	set("CFBundleName", "Electron");
	set("CFBundleDisplayName", "Electron");
	remove("CFBundleIconName");
	remove(DIGEST_KEY);
	rmSync(join(bundle, "Contents", "Resources", "Assets.car"), { force: true });

	const originalApp = join(dirname(bundle), "Electron.app");
	if (bundle !== originalApp && !existsSync(originalApp)) {
		renameSync(bundle, originalApp);
		bundle = originalApp;
	}
	const pathFile = pathFileFor(bundle);
	if (existsSync(pathFile)) writeFileSync(pathFile, "Electron.app/Contents/MacOS/Electron");

	sign();
	console.log("[brand] Electron bundle restored — safe to package");
	process.exit(0);
}

set("CFBundleName", NAME);
set("CFBundleDisplayName", NAME);
set("CFBundleIdentifier", APP_ID);

/*
 * Rename the binary, and leave a symlink behind under the old name.
 *
 * The symlink is not optional: `electron/index.js` joins `dist` with whatever `path.txt` says,
 * and other tools in the chain have the original layout baked in. Renaming without it is how the
 * `electron` command stops finding its own binary.
 */
const macOS = join(bundle, "Contents", "MacOS");
const original = join(macOS, "Electron");
const renamed = join(macOS, NAME);
if (existsSync(original) && !existsSync(renamed)) {
	renameSync(original, renamed);
	symlinkSync(NAME, original);
	set("CFBundleExecutable", NAME);
}

if (iconStale) copyFileSync(icon, iconTarget);

if (assetsStale) {
	const work = mkdtempSync(join(tmpdir(), "plume-icon-"));
	try {
		// `--app-icon` names the icon inside the document, which is the document's file name.
		cpSync(iconDocument, join(work, "Icon.icon"), { recursive: true });
		execFileSync(
			"xcrun",
			[
				"actool",
				join(work, "Icon.icon"),
				"--compile",
				work,
				"--app-icon",
				"Icon",
				"--include-all-app-icons",
				"--output-partial-info-plist",
				join(work, "info.plist"),
				"--target-device",
				"mac",
				"--minimum-deployment-target",
				"26.0",
				"--platform",
				"macosx",
			],
			{ stdio: "ignore" },
		);
		copyFileSync(join(work, "Assets.car"), join(bundle, "Contents", "Resources", "Assets.car"));
		set("CFBundleIconName", "Icon");
	} catch {
		// No Xcode 26: the `.icns` above still shows, just without the dark variant.
		console.log("[brand] actool unavailable — development icon will not follow dark mode");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	// Recorded either way, so a machine without `actool` does not retry on every start.
	set(DIGEST_KEY, iconDigest);
}

// The last fallback the dock reaches for, and the one VS Code changes as well.
const renamedApp = join(dirname(bundle), `${NAME}.app`);
if (bundle !== renamedApp && !existsSync(renamedApp)) {
	renameSync(bundle, renamedApp);
	bundle = renamedApp;
}

/*
 * `path.txt` is how the `electron` command finds the binary, and it decides argv[0].
 *
 * Left pointing at the old path, launching goes through the compatibility symlink — and macOS
 * takes the process name from argv[0] without resolving symlinks, so the dock would still say
 * Electron with everything else already correct.
 */
const pathFile = pathFileFor(bundle);
if (existsSync(pathFile)) {
	const want = `${NAME}.app/Contents/MacOS/${NAME}`;
	if (readFileSync(pathFile, "utf8").trim() !== want) writeFileSync(pathFile, want);
}

sign();

/*
 * The Dock's icon cache is keyed by the bundle's path and modification time, and replacing a file
 * inside `Contents/Resources` changes neither. pnpm unpacks the bundle with a 1970 mtime, so
 * without this the restarted Dock rebuilds its cache from the old entry and keeps the old icon.
 */
const now = new Date();
utimesSync(bundle, now, now);

// LaunchServices caches bundle metadata by path, and neither an edited plist nor a relaunch
// invalidates that record. This is what makes it re-read.
try {
	execFileSync(LSREGISTER, ["-f", bundle], { stdio: "ignore" });
} catch {
	// Restarting the Dock below reaches the same place.
}

/*
 * The Dock keeps its own copy on top of LaunchServices.
 *
 * This was the last one holding the old name: `lsappinfo` reported Plume while the tooltip still
 * said Electron. Only on an actual change — an `electron` reinstall or a new `build/icon.icns`
 * or `build/icon.icon`.
 * The Dock relaunches itself within a second, but it is the user's whole desktop, and flickering
 * it on every `pnpm dev` for no change would not be worth it.
 */
try {
	execFileSync("/usr/bin/killall", ["Dock"], { stdio: "ignore" });
} catch {
	// Not running, or not permitted.
}

console.log(`[brand] development Electron bundle is now ${NAME} (${APP_ID})`);
