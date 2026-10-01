import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { seedInteractions } from "./interaction-fixture.ts";
import { fixtureStore, seedSessions, type FixtureRecord, type FixtureSession } from "./session-fixture.ts";

export const LONG_QUESTION = "完整问题起点\n" + "请检查所有环境、原始路径与中文输入法行为。 VeryLongPathSegment_without_breaks_".repeat(24) + "\n完整问题终点";
export const LONG_OPTIONS = Array.from({ length: 6 }, (_, index) => `${index + 1}. 继续检查 ${"保留必要的原始上下文以及验证记录 ".repeat(8)}`.trim());

export const REFERENCE_TITLE = "同名会话：" + "跨平台交互与上下文引用验收_LongReferenceTitle_".repeat(8);

/** Controlled model responses still traverse the real provider, tool runner and approval IPC. */
export function questionModel() {
	const requests: Array<{ messages: unknown[] }> = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body: unknown = JSON.parse(raw);
			assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
			requests.push({ messages: body.messages });
			// The provider appends an environment message after the actual prompt or tool result.
			const content = JSON.stringify(body.messages.slice(-3));
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (content.includes('"tool_result"')) reply(res, "原会话已收到回答。");
			else if (content.includes("ASK_LONG")) reply(res, "", { id: "question-long", question: LONG_QUESTION, options: LONG_OPTIONS, allowCustomInput: true });
			else if (content.includes("ASK_OWNER")) reply(res, "", { id: "question-owner", options: ["保留原实现", "更新实现"], allowCustomInput: false });
			else if (content.includes("ASK_CUSTOM")) reply(res, "", { id: "question-custom", options: [], allowCustomInput: true });
			else reply(res, "引用已接收。");
		});
	});
	return { server, requests };
}

function reply(res: ServerResponse, text: string, question?: { id: string; question?: string; options: string[]; allowCustomInput: boolean }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "mention-question", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: question ? { type: "tool_use", id: question.id, name: "ask_user", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: question ? { type: "input_json_delta", partial_json: JSON.stringify({ question: question.question ?? (question.allowCustomInput ? "你希望如何继续？" : "请选择本次实现方式"), options: question.options, allowCustomInput: question.allowCustomInput }) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: question ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}

/** Synthetic sessions have identical long titles and distinct IDs; their logs use normal storage. */
export async function seedQuestions(home: string, modelPort: number) {
	await seedInteractions(home, modelPort);
	const store = fixtureStore(home);
	const sessions: FixtureSession[] = [];
	for (const meta of await store.listSessions()) {
		const records: FixtureRecord[] = [];
		for await (const record of store.read(meta.id)) records.push(record);
		sessions.push({ meta, records });
	}
	store.close();
	const rename = (text: string) => text.replaceAll('"title":"qa-long"', `"title":${JSON.stringify(REFERENCE_TITLE)}`).replaceAll('"title":"qa-short"', `"title":${JSON.stringify(REFERENCE_TITLE)}`);
	seedSessions(home, JSON.parse(rename(JSON.stringify(sessions))));
	const path = join(home, "settings.json");
	const settings: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", thinking: "off", projectMemory: false, appearance: { theme: "dark", reduceMotion: "off" } }));
}
