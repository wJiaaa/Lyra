/**
 * The settings a browser opened through Web access gets to see.
 *
 * The renderer needs most of them to draw anything — models, appearance, projects, the language —
 * so it gets the object rather than a digest. What it does not get is anything that is a secret on
 * this machine or a command this machine runs: provider keys and headers, MCP servers (their
 * `env` carries keys, their `command` is a program), hooks and scheduled tasks (shell commands),
 * search keys, and the Web access token itself — the browser already holds it in a cookie, and
 * nothing it draws needs to print it.
 *
 * Read-only by construction: `settings.save` is not on the allowlist (see `web-rpc.ts`), so this
 * has no inverse to keep in step with.
 */

import type { Settings } from "@lyra/core";

export function settingsForWeb(settings: Settings): Settings {
	return {
		...settings,
		providers: settings.providers.map((provider) => ({
			...provider,
			apiKey: "",
			headers: undefined,
		})),
		mcpServers: [],
		hooks: [],
		scheduledTasks: [],
		searchApiKeys: {},
		webAccess: { ...settings.webAccess, token: null },
	};
}
