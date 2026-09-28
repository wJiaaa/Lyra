/**
 * The reported 400, end to end: a real turn that asks for two tools at once.
 *
 * `node e2e/probe-parallel-tools.ts` — not a test, because it spends a real request against
 * whatever provider this machine has configured. It exists because the unit tests check the shape
 * of the request and the relay check checks the relay's answer, and neither of them proves that
 * what the app sends is what was fixed.
 *
 * Borrows the provider and model from the local profile, and runs in a scratch project of its own.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";

const settings = JSON.parse(await readFile(join(homedir(), ".plume", "settings.json"), "utf8"));
const wanted = process.argv[2];
const provider = wanted
	? settings.providers.find((p: { models: { modelId: string }[] }) => p.models.some((m) => m.modelId === wanted))
	: settings.providers.find((p: { models: unknown[] }) => p.models.length > 0);
const model = provider?.models.find((m: { modelId: string }) => m.modelId === wanted) ?? provider?.models[0];
if (!model) throw new Error("no configured model to test against");
process.stdout.write(`using ${provider.name} / ${model.modelId}\n`);

const app = await startApp({
	port: 9465,
	seed: async (home) => {
		const project = join(home, "demo");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "readme.md"), "# demo\n");
		await writeFile(join(project, "notes.md"), "notes\n");
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				...settings,
				projects: [{ path: project, name: "demo", pinned: false, lastOpenedAt: Date.now() }],
				defaultModelId: model.id,
				permissionMode: "full",
				thinking: "off",
			}),
		);
	},
});

const send = (text: string) =>
	app.evaluate<boolean>(`(() => {
		const field = document.querySelector("textarea");
		if (!field) return false;
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		setter?.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);

try {
	await new Promise((r) => setTimeout(r, 2500));
	await send("在一条回复里同时调用两个工具：用 bash 执行 `ls -la`，并用 glob 查找 `**/*.md`。两个工具调用必须在同一轮里一起发出，然后用一句话总结结果。");

	/*
	 * Wait for the turn to actually finish rather than for a fixed number of seconds.
	 *
	 * The failure being checked for is on the *second* request of the turn — the one carrying the
	 * tool results — so a probe that stops while the first one is still streaming would report a
	 * clean run for a turn that had not yet reached the part that used to break.
	 */
	let transcript = "";
	for (let waited = 0; waited < 180_000; waited += 4000) {
		await new Promise((r) => setTimeout(r, 4000));
		transcript = await app.evaluate<string>(`document.body.innerText`);
		if (/HTTP 400|did not have response messages/.test(transcript)) break;
		// The running line counts seconds while a turn is in flight, and goes when it ends.
		const running = await app.evaluate<boolean>(`/·\\s*\\d+s/.test(document.body.innerText)`);
		const answered = /Find \*\*\/\*\.md/.test(transcript) && !running;
		if (answered) break;
	}

	const failed = /HTTP 400|did not have response messages/.test(transcript);
	process.stdout.write(`\n${failed ? "❌ 400 是原样复现的" : "✅ 没有 400"}\n`);
	// Both tools in the same turn is the case that used to fail; one at a time never did.
	const grouped = /执行命令、查找文件|Find \*\*\/\*\.md/.test(transcript);
	process.stdout.write(`both tools in one turn: ${grouped ? "yes" : "no"}\n`);
	process.stdout.write(`--- transcript tail ---\n${transcript.slice(-700)}\n`);
} finally {
	await app.stop();
}
