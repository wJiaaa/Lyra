/**
 * 「开机时启动」 on Linux, where Electron has no implementation of it.
 *
 * `app.setLoginItemSettings` works on macOS and Windows only; on Linux it does nothing and
 * `getLoginItemSettings` answers false, so the tray's tick never stuck and nothing ever started at
 * login. Linux desktops read `~/.config/autostart/*.desktop` (the XDG autostart spec), and that
 * file is what the item now writes and reads.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	DESKTOP_FILE,
	autostartArgv,
	autostartEnabled,
	autostartEntry,
	autostartFile,
	readAutostart,
	writeAutostart,
} from "../electron/linux-autostart.ts";

test("the file lives under XDG_CONFIG_HOME when it is absolute, ~/.config otherwise", () => {
	assert.equal(autostartFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/me"), join("/cfg", "autostart", DESKTOP_FILE));
	// The spec says a relative value is invalid and must be ignored.
	assert.equal(autostartFile({ XDG_CONFIG_HOME: "cfg" }, "/home/me"), join("/home/me", ".config", "autostart", DESKTOP_FILE));
	assert.equal(autostartFile({}, "/home/me"), join("/home/me", ".config", "autostart", DESKTOP_FILE));
});

test("the entry is named like the installed launcher", () => {
	const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
	const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { desktopName: string };
	assert.equal(DESKTOP_FILE, pkg.desktopName);
});

test("what starts at login is the AppImage itself, not the copy mounted for this run", () => {
	assert.deepEqual(autostartArgv({ appImage: "/home/me/Apps/Plume.AppImage", packaged: true, execPath: "/tmp/.mount_Plume/plume", appPath: "/x" }), [
		"/home/me/Apps/Plume.AppImage",
	]);
	assert.deepEqual(autostartArgv({ packaged: true, execPath: "/opt/Plume/Plume", appPath: "/opt/Plume/resources/app.asar" }), ["/opt/Plume/Plume"]);
	// A development run is Electron plus the source directory.
	assert.deepEqual(autostartArgv({ packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo/packages/desktop" }), [
		"/repo/node_modules/electron/dist/electron",
		"/repo/packages/desktop",
	]);
});

test("Exec is quoted by the Desktop Entry rules — spaces, $, backslashes and % included", () => {
	const entry = autostartEntry(["/home/me/My Apps/Plume $1\\x 100%.AppImage"]);
	const exec = entry.split("\n").find((line) => line.startsWith("Exec="));
	// Quoted for the space; `$` and `\` escaped inside the quotes and then again as a string value;
	// a literal % written as %% so it is not read as a field code.
	assert.equal(exec, 'Exec="/home/me/My Apps/Plume \\\\$1\\\\\\\\x 100%%.AppImage"');
	assert.equal(autostartEntry(["/opt/Plume/Plume"]).split("\n").find((line) => line.startsWith("Exec=")), "Exec=/opt/Plume/Plume");
	assert.ok(entry.startsWith("[Desktop Entry]\n"));
	assert.ok(entry.includes("\nType=Application\n"));
});

test("an entry the desktop was told to skip does not count as on", () => {
	assert.equal(autostartEnabled("[Desktop Entry]\nType=Application\nExec=/opt/Plume/Plume\n"), true);
	assert.equal(autostartEnabled("[Desktop Entry]\nExec=/opt/Plume/Plume\nHidden=true\n"), false);
	assert.equal(autostartEnabled("[Desktop Entry]\nExec=/opt/Plume/Plume\nX-GNOME-Autostart-enabled=false\n"), false);
	// Only the main group decides; an action group saying Hidden=true is about something else.
	assert.equal(autostartEnabled("[Desktop Entry]\nExec=a\n\n[Desktop Action x]\nHidden=true\n"), true);
});

test("turning it on writes the file, turning it off removes it, and reading agrees both times", () => {
	const root = mkdtempSync(join(tmpdir(), "plume-autostart-"));
	try {
		const file = autostartFile({ XDG_CONFIG_HOME: root }, "/nowhere");
		assert.equal(readAutostart(file), false);
		writeAutostart(file, true, ["/opt/Plume/Plume"]);
		assert.ok(existsSync(file));
		assert.equal(readAutostart(file), true);
		writeAutostart(file, false, ["/opt/Plume/Plume"]);
		assert.equal(existsSync(file), false);
		assert.equal(readAutostart(file), false);
		// Off when it is already off is not an error.
		writeAutostart(file, false, ["/opt/Plume/Plume"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a hand-disabled entry reads as off, and turning it on replaces it", () => {
	const root = mkdtempSync(join(tmpdir(), "plume-autostart-"));
	try {
		const file = autostartFile({ XDG_CONFIG_HOME: root }, "/nowhere");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "[Desktop Entry]\nExec=/old/Plume\nHidden=true\n");
		assert.equal(readAutostart(file), false);
		writeAutostart(file, true, ["/opt/Plume/Plume"]);
		assert.equal(readAutostart(file), true);
		assert.ok(readFileSync(file, "utf8").includes("Exec=/opt/Plume/Plume"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
