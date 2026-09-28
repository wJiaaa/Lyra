/**
 * Plugins that arrive on disk.
 *
 * The claim this test defends is the strong reading of "everything is a plugin": not merely that
 * the host can assemble a different set, but that dropping a directory into `~/.plume/plugins`
 * changes what the agent is made of — including replacing a seam the app ships with.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, DEFAULT_PLUGINS, SANDBOX, type Sandbox } from "../src/kernel/index.ts";
import { loadCapabilityPlugins } from "../src/plugins/capability.ts";
import { loadPlugins } from "../src/plugins/loader.ts";

/** Write a bundle the loader will accept, with the given `capability.js` body. */
async function bundle(root: string, id: string, body: string) {
	const dir = join(root, id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "plugin.json"),
		JSON.stringify({ name: id, version: "1.0.0", description: "test bundle" }),
	);
	await writeFile(join(dir, "capability.js"), body);
	return dir;
}

test("a plugin on disk can replace a seam the app ships with", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-cap-"));
	try {
		await bundle(
			root,
			"remote-sandbox",
			`export default {
				name: "remote-sandbox",
				apply(ctx) {
					return ctx.provide("sandbox", { run: () => ({ marker: "from disk" }) });
				},
			};`,
		);

		const found = await loadPlugins([{ dir: root, source: "user" }]);
		const { plugins, diagnostics } = await loadCapabilityPlugins(found.plugins);
		assert.deepEqual(diagnostics, []);
		assert.equal(plugins.length, 1);

		/*
		 * Loaded *instead of* the built-in, not alongside it: a service can only be provided once,
		 * so the default sandbox plugin is left out of the list. That is what replacing means.
		 */
		const withoutSandbox = DEFAULT_PLUGINS.filter((plugin) => plugin.name !== "sandbox");
		const ctx = await createContext([...withoutSandbox, ...plugins]);
		try {
			const sandbox = ctx.require<Sandbox>(SANDBOX) as unknown as { run: () => { marker: string } };
			assert.equal(sandbox.run().marker, "from disk", "the disk plugin is what answers");
		} finally {
			await ctx.dispose();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a broken plugin is reported and skipped, not fatal", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-cap-"));
	try {
		await bundle(root, "throws", "throw new Error('boom');");
		await bundle(root, "empty", "export const nothing = 1;");
		await bundle(root, "wrong-shape", "export default { name: 'x' };");
		await bundle(root, "good", `export default { name: "good", apply(ctx) { return ctx.provide("ok", 1); } };`);

		const found = await loadPlugins([{ dir: root, source: "user" }]);
		const { plugins, diagnostics } = await loadCapabilityPlugins(found.plugins);

		assert.equal(plugins.length, 1, "the working one still loaded");
		assert.equal(plugins[0].name, "good");
		assert.equal(diagnostics.length, 3, "and each broken one said why");
		assert.ok(diagnostics.some((d) => d.message.includes("boom")));
		assert.ok(diagnostics.some((d) => d.message.includes("没有导出")));
		assert.ok(diagnostics.some((d) => d.message.includes("需要 name 与 apply")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a bundle with no capability.js is simply a bundle, not an error", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-cap-"));
	try {
		const dir = join(root, "skills-only");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "skills-only", version: "1.0.0" }));

		const found = await loadPlugins([{ dir: root, source: "user" }]);
		const { plugins, diagnostics } = await loadCapabilityPlugins(found.plugins);
		assert.deepEqual(plugins, []);
		assert.deepEqual(diagnostics, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a run can decline every plugin without naming any of them", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-cap-"));
	try {
		await bundle(root, "one", "export default { name: 'one', apply() {} };");
		await bundle(root, "two", "export default { name: 'two', apply() {} };");

		const all = await loadPlugins([{ dir: root, source: "user" }]);
		assert.equal(all.plugins.filter((p) => p.enabled).length, 2, "both are there to begin with");

		/*
		 * The case this exists for: a session that has to be reproducible — running in CI, or
		 * reproducing a report — cannot have its capabilities decided by what happens to be
		 * installed. Naming each plugin is not an option, because not knowing is the point.
		 */
		const none = await loadPlugins([{ dir: root, source: "user" }], ["*"]);
		assert.equal(none.plugins.filter((p) => p.enabled).length, 0);
		assert.equal(none.plugins.length, 2, "still discovered and still reportable, just not active");

		const one = await loadPlugins([{ dir: root, source: "user" }], ["one"]);
		assert.deepEqual(
			one.plugins.filter((p) => p.enabled).map((p) => p.id),
			["two"],
			"naming one still disables only that one",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
