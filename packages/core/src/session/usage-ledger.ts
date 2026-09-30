/**
 * Model calls that belong to no session, and what they cost.
 *
 * Cost is counted from session logs, so a call without a session was free as far as the settings
 * page could tell. The project memory pass is one: it reads dozens of sessions and answers for
 * none of them. Charging it to whichever session happened to be open would put a cost in that
 * conversation it never incurred, so it gets a log of its own, outside `sessions/` — a file there
 * would be listed as a conversation.
 *
 * Lines have the shape of a session's `usage` record, so the usage scan reads them the same way.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "../types.ts";
import { plumeHome } from "./store.ts";

export function usageLedgerPath(home = plumeHome()): string {
	return join(home, "usage-ledger.jsonl");
}

export async function recordLedgerUsage(
	spent: { source: string; providerId: string; modelId: string; usage: Usage },
	home = plumeHome(),
): Promise<void> {
	await mkdir(home, { recursive: true });
	await appendFile(usageLedgerPath(home), `${JSON.stringify({ ts: Date.now(), type: "usage", ...spent })}\n`, "utf8");
}
