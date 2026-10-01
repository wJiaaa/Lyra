import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedSessions } from "./session-fixture.ts";

export const IDS = ["dock-a", "dock-b", "dock-c", "dock-d"] as const;

export async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# floor\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const sessions = [];
	for (const [index, id] of IDS.entries()) {
		const messages = [
			{ role: "user", content: [{ type: "text", text: `会话 ${id} 用来验证分屏拖拽验证` }], timestamp: index * 10 },
			{ role: "assistant", content: [{ type: "text", text: `${id} 的回复。` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: index * 10 + 1 },
		];
		const meta = {
			id,
			title: `地板 ${id.slice(-1).toUpperCase()}`,
			projectId,
			projectName: "分屏拖拽验证",
			cwd,
			createdAt: 1 + index,
			updatedAt: 100 - index,
			modelId: "qa/model",
			messageCount: messages.length,
			usage,
			seq: 3,
		};
		sessions.push({
			meta,
			records: [
				{ type: "meta", meta, seq: 0, ts: 1 },
				...messages.map((message, i) => ({ type: "message", message, seq: i + 1, ts: 1 })),
				{ type: "meta", meta, seq: 3, ts: 2 },
			],
		});
	}
	seedSessions(home, sessions);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1360, height: 850, x: 40, y: 40 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: projectId, path: cwd, name: "分屏拖拽验证", pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			uiLocale: "zh-CN",
			appearance: { theme: "dark" },
		}),
	);
}
