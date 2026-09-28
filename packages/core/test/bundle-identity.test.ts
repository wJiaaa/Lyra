/**
 * What a bundle's `id` is, and the four places that have to agree about it.
 *
 * A bundle is installed into a directory named after the registry entry, its servers are stamped
 * with where they came from, it is later found again by a scan of that directory, and it is
 * eventually removed by id. Those are four different pieces of code deriving "which bundle is
 * this" — and for as long as the directory name and the manifest's `name` were the same string,
 * all four agreed by accident.
 *
 * They are not always the same string. `inferManifest` deliberately prefers the name inside a
 * `.claude-plugin/marketplace.json` over the directory, so that a bundle arrives called what it
 * calls itself instead of whatever its folder is called. That is the right thing to show a person
 * and the wrong thing to identify a directory by, and every symptom of confusing the two is silent:
 *
 *   - uninstalling removes `~/.plume/mcp/<manifest name>`, which does not exist, and reports success
 *   - the settings rows are matched on the same wrong name, so the server stays in the list
 *   - the scan then finds a bundle with no row and writes a fresh one, on every single scan
 *
 * So the rule these pin down is: the directory is the identity, the manifest is the label.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlugins } from "../src/plugins/loader.ts";
import { bundleRoot, uninstallEntry } from "../src/plugins/registry.ts";

async function withHome(body: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "plume-identity-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	try {
		await body(home);
	} finally {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
}

/**
 * An MCP bundle installed as `dir`, calling itself `named` in a Claude marketplace file.
 *
 * Exactly the shape found in the wild: a repository published for Claude Code, listed in the
 * registry under its repository's name, whose marketplace file gives it a prettier one.
 */
async function bundleCalled(dir: string, named: string): Promise<string> {
	const root = join(bundleRoot("mcp"), dir);
	await mkdir(join(root, ".claude-plugin"), { recursive: true });
	await writeFile(
		join(root, ".mcp.json"),
		JSON.stringify({ mcpServers: { server: { command: "npx", args: ["-y", "@x/server"] } } }),
	);
	await writeFile(
		join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({ name: "some-marketplace", plugins: [{ name: named, description: "测试。" }] }),
	);
	return root;
}

test("a bundle is identified by its directory, not by the name it prefers to be called", async () => {
	await withHome(async () => {
		await bundleCalled("context7", "Context7 MCP");

		const { mcpBundles } = await loadPlugins([{ dir: bundleRoot("mcp"), source: "user" }], []);

		assert.equal(mcpBundles.length, 1);
		assert.equal(mcpBundles[0].id, "context7", "the directory, which is what install created and uninstall removes");
		assert.equal(
			mcpBundles[0].manifest.interface?.displayName ?? mcpBundles[0].manifest.name,
			"Context7 MCP",
			"and the label it chose is still what a person sees",
		);
	});
});

test("its servers are stamped with the same id the bundle is listed under", async () => {
	await withHome(async () => {
		/*
		 * `origin.bundle` is the only thing tying a settings row back to a directory. If it disagrees
		 * with `bundle.id`, then reconciliation cannot find the row it just wrote — so every scan
		 * decides the bundle is missing and appends its servers again. The list grows by one copy
		 * every time the plugins page is opened.
		 */
		await bundleCalled("context7", "Context7 MCP");

		const { mcpBundles } = await loadPlugins([{ dir: bundleRoot("mcp"), source: "user" }], []);

		assert.equal(mcpBundles[0].servers[0].origin?.bundle, mcpBundles[0].id);
	});
});

test("uninstalling by that id removes the directory it names", async () => {
	await withHome(async () => {
		await bundleCalled("context7", "Context7 MCP");

		const { mcpBundles } = await loadPlugins([{ dir: bundleRoot("mcp"), source: "user" }], []);
		await uninstallEntry(mcpBundles[0].id);

		assert.deepEqual(await readdir(bundleRoot("mcp")), [], "the id the UI holds is the id that removes it");
	});
});

test("a plugin, likewise: renamed by its marketplace file, still removable", async () => {
	await withHome(async () => {
		const root = join(bundleRoot("plugin"), "agentic-note-taking");
		await mkdir(join(root, "skills", "capture"), { recursive: true });
		await mkdir(join(root, ".claude-plugin"), { recursive: true });
		await writeFile(join(root, "skills", "capture", "SKILL.md"), "---\nname: capture\ndescription: 测试。\n---\n");
		await writeFile(
			join(root, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ name: "agenticnotetaking", plugins: [{ name: "Agentic Note Taking" }] }),
		);

		const { plugins } = await loadPlugins([{ dir: bundleRoot("plugin"), source: "user" }], []);
		assert.equal(plugins.length, 1);
		await uninstallEntry(plugins[0].id);

		assert.deepEqual(await readdir(bundleRoot("plugin")), []);
	});
});

test("a manifest that renames a plugin does not switch off the one the user disabled", async () => {
	await withHome(async () => {
		/*
		 * The compatibility this identity change owes.
		 *
		 * `disabledPlugins` is a list of ids written by earlier versions, and those ids were whatever
		 * the manifest called the bundle. Reading the directory name instead would quietly re-enable
		 * everything anyone had switched off — a migration that turns things on is exactly what the
		 * rest of this module bends over backwards to avoid, so both names are honoured.
		 */
		const root = join(bundleRoot("plugin"), "note-taking");
		await mkdir(join(root, "skills", "capture"), { recursive: true });
		await writeFile(join(root, "skills", "capture", "SKILL.md"), "---\nname: capture\ndescription: 测试。\n---\n");
		await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "Agentic Note Taking", skills: "skills" }));

		const byOldId = await loadPlugins([{ dir: bundleRoot("plugin"), source: "user" }], ["Agentic Note Taking"]);
		const byNewId = await loadPlugins([{ dir: bundleRoot("plugin"), source: "user" }], ["note-taking"]);

		assert.equal(byOldId.plugins[0].enabled, false, "the name it was disabled under still disables it");
		assert.equal(byNewId.plugins[0].enabled, false, "and so does the directory it lives in");
	});
});
