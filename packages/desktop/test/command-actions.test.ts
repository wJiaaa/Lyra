/**
 * 「设置 › 命令」页列出的内置命令，就是输入框 `/` 菜单里的那几条。
 *
 * 两边从前各写一份清单，菜单加了 `/plan`、`/goal`，设置页停在四条。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "@plume/core";
import { listCommands } from "../electron/commands-service.ts";
import { commandEntries } from "../src/features/composer/command-catalog.ts";

test("设置页和 / 菜单列出同样的内置命令", async () => {
	const home = await mkdtemp(join(tmpdir(), "plume-command-actions-"));
	const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	// 两个都设：Windows 上 `os.homedir()` 读的是 USERPROFILE。
	Object.assign(process.env, { PLUME_HOME: join(home, ".plume"), HOME: home, USERPROFILE: home });
	try {
		const settingsPage = (await listCommands(home, DEFAULT_SETTINGS)).builtins.map((command) => command.name);
		const menu = commandEntries([], []).filter((entry) => entry.kind === "builtin").map((entry) => entry.name);
		assert.deepEqual(settingsPage, menu);
		assert.ok(settingsPage.includes("plan") && settingsPage.includes("goal"), settingsPage.join(", "));
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(home, { recursive: true, force: true });
	}
});
