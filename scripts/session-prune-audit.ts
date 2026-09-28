/** Read-only production-policy replay, not a prediction of future invoices or cache hits. */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../packages/core/src/session/store.ts";
import { AgedToolPruner } from "../packages/core/src/runtime/aged-prune.ts";
import { dropStaleResults } from "../packages/core/src/runtime/stale-results.ts";
import { boundedGrepLines } from "../packages/core/src/tools/grep.ts";
import type { Message } from "../packages/core/src/types.ts";

const root = join(homedir(), ".lyra", "sessions");
const store = new SessionStore(root);
const chars = (messages: Message[]) => messages.reduce((sum, message) => sum + (message.role === "toolResult" ? message.content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0) : 0), 0);
let sessions = 0, requests = 0, before = 0, afterSend = 0, afterStale = 0, afterGrep = 0, combined = 0, rewrites = 0, maxGrepBefore = 0, maxGrepAfter = 0;
for (const project of await readdir(root, { withFileTypes: true })) {
	if (!project.isDirectory()) continue;
	for (const file of await readdir(join(root, project.name))) {
		if (!file.endsWith(".jsonl")) continue;
		const original = await store.messages(project.name, file.slice(0, -6));
		const history: Message[] = [], bounded: Message[] = [];
		const send = new AgedToolPruner(), both = new AgedToolPruner();
		sessions++;
		for (const message of original) {
			if (message.role === "assistant") {
				requests++;
				const pruned = send.prepare(history), trimmed = both.prepare(bounded);
				// 覆盖判断只在压缩里做；这里量的是它在压缩时能清掉多少，不是发送路径的行为。
				const stale = dropStaleResults(history);
				before += chars(history); afterSend += chars(pruned); afterStale += chars(stale); afterGrep += chars(bounded); combined += chars(trimmed);
				rewrites += pruned.filter((m, i) => m !== history[i]).length;
			}
			history.push(message);
			if (message.role === "toolResult" && message.toolName === "grep") {
				const content = message.content.map(part => part.type === "text" ? { ...part, text: boundedGrepLines(part.text.split("\n")).join("\n") } : part);
				const capped = { ...message, content };
				maxGrepBefore = Math.max(maxGrepBefore, chars([message])); maxGrepAfter = Math.max(maxGrepAfter, chars([capped]));
				bounded.push(capped);
			} else bounded.push(message);
		}
	}
}
console.log(JSON.stringify({
	label: "Historical message replay; tool-result UTF-16 characters × subsequent requests; does not simulate model behaviour, compaction, invoices or cache hits",
	sessions, requests, before, afterSend, afterStale, afterGrep, combined,
	sendSaving: 1 - afterSend / before,
	staleSaving: 1 - afterStale / before,
	grepSaving: 1 - afterGrep / before,
	combinedSaving: 1 - combined / before,
	rewrites, maxGrepBefore, maxGrepAfter,
}, null, 2));
