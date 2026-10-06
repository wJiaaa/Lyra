import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp } from "./app.ts";

test("the welcome page hides the mascot and a conversation shows it with either top-row setting", async () => {
	for (const showTop of [true, false]) {
		const app = await startApp({
			port: 9894,
			seed: async (home) => {
				const project = join(home, "project");
				await mkdir(project);
				await writeFile(join(home, "window.json"), JSON.stringify({ width: 980, height: 680, x: 20, y: 20 }));
				await writeFile(join(home, "settings.json"), JSON.stringify({
					version: 1,
					providers: [{
						id: "relay", name: "Relay", baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-responses", apiKey: "x", enabled: true,
						models: [{
							id: "relay/test", providerId: "relay", modelId: "test", name: "test",
							contextWindow: 128000, maxOutputTokens: 8192,
							supportsThinking: false, supportsImages: false, supportsTools: true,
						}],
					}],
					mcpServers: [],
					projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
					defaultModelId: "relay/test",
					permissionMode: "auto", thinking: "off", retryAttempts: 1,
					hooks: [], scheduledTasks: [], disabledPlugins: [],
					pluginRegistries: [], skillRegistries: [], alwaysAllow: [],
					editor: { defaultOpenTarget: "zed", showBottomPanel: showTop },
					appearance: { theme: "dark" },
				}));
			},
		});
		try {
			const read = () => app.evaluate<{ surface: string | null; top: boolean; mascot: boolean; hero: boolean }>(
				"(() => { const surface = document.querySelector('[data-ly-chat-surface]'); const tray = surface?.querySelector('.ly-composer-tray'); return { surface: surface?.getAttribute('data-ly-chat-surface') ?? null, top: Boolean(tray?.querySelector(':scope > .flex.items-center')), mascot: Boolean(tray?.querySelector('.ly-composer-mascot')), hero: Boolean(surface?.querySelector('.ly-plume-mark')) }; })()",
			);
			assert.deepEqual(await read(), { surface: "empty", top: showTop, mascot: false, hero: true });

			const id = await app.evaluate<string>(
				"(async () => { const made = await window.plume.sessions.create((await window.plume.settings.get()).projects[0].path, 'relay/test'); await window.plume.agent.prompt(made.meta.id, [{ type: 'text', text: 'hi' }]); return made.meta.id; })()",
			);
			let opened = false;
			for (let attempt = 0; attempt < 30 && !opened; attempt++) {
				opened = await app.evaluate<boolean>(
					"(() => { const row = document.querySelector('[data-ly-row=" + JSON.stringify(id) + "] button'); if (!row) return false; row.click(); return true; })()",
				);
				if (!opened) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(opened, "the conversation must be listed");
			let state = await read();
			for (let attempt = 0; attempt < 30 && state.surface !== "conversation"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				state = await read();
			}
			assert.deepEqual(state, { surface: "conversation", top: showTop, mascot: true, hero: false });
		} finally {
			await app.stop();
		}
	}
});
