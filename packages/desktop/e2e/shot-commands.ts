/**
 * A picture of the slash-command list, for looking at rather than asserting on.
 *
 * `node e2e/shot-commands.ts <out.png>`. Kept beside the tests because it boots the app the same
 * way they do — reviewing how something is *drawn* against a DOM assertion is reviewing a
 * description of the picture.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/lyra-commands.png";
const typed = process.argv[3] ?? "/";

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });

	// A realistic spread: ours, a nested one, and one written for Claude Code.
	const mine = join(home, "commands");
	await mkdir(join(mine, "git"), { recursive: true });
	await writeFile(
		join(mine, "review-diff.md"),
		"---\ndescription: 审查当前未提交的改动，指出风险\nargument-hint: <路径>\n---\n审查 $ARGUMENTS。",
	);
	await writeFile(join(mine, "commit-message.md"), "---\ndescription: 按仓库的风格写一条提交信息\n---\n写提交信息。");
	await writeFile(join(mine, "git", "sync.md"), "---\ndescription: 拉取远端并变基当前分支\n---\n同步。");
	await mkdir(join(project, ".claude", "commands"), { recursive: true });
	await writeFile(join(project, ".claude", "commands", "security-review.md"), "---\ndescription: 检查注入与越权风险\n---\n审查。");
	await writeFile(join(project, ".claude", "commands", "ship-it.md"), "---\ndescription: 发布前的完整检查清单\n---\n检查。");

	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 820, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: {
				theme: process.argv[4] === "dark" ? "dark" : "light",
			},
		}),
	);
}

const app = await startApp({ port: 9481, seed });
try {
	await new Promise((r) => setTimeout(r, 2500));
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(typed)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);
	await new Promise((r) => setTimeout(r, 1200));

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`${out}\n`);
} finally {
	await app.stop();
}
