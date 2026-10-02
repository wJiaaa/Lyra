/**
 * Cutting a conversation back to a message, and everything that has to follow the cut.
 *
 * Undo and edit-and-resend make the same cut; they differ only in what happens around it (edit
 * stops a running turn first and asks again afterwards, undo refuses while a turn runs). The cut
 * itself is one thing, so it is written once — edit-and-resend once missed the plan step below,
 * while cutting just as much as undo and then running straight away.
 */

import type { AgentEventSink } from "../agent/events.ts";
import { TODOS_KEY, todosFromLog } from "../tools/todo.ts";
import type { DelegationWaits } from "./delegation-waits.ts";
import type { SessionDeliveries } from "./session-deliveries.ts";
import type { SessionLog } from "./session-log.ts";
import type { SubAgentRegistry } from "./sub-agents.ts";

export interface RewindParts {
	log: SessionLog;
	/** The session's tool state, where this turn's copy of the plan lives. */
	state: Map<string, unknown>;
	deliveries: SessionDeliveries;
	delegations: DelegationWaits;
	subAgents: SubAgentRegistry;
	emit: AgentEventSink;
}

/** Drop every message from `messageIndex` on, and what was built on them. */
export async function rewind(parts: RewindParts, messageIndex: number): Promise<void> {
	if (!(await parts.log.truncateFrom(messageIndex))) {
		throw new Error(`Failed to truncate message at index ${messageIndex}`);
	}
	restorePlan(parts);
	stopCutDelegations(parts);
	await parts.emit({ type: "rewound", messageCount: parts.log.messages.length });
}

/**
 * The plan goes back to the cut too.
 *
 * It is written in two places — the result of a `todo_write` in the log, and the state this turn
 * uses. Truncating reaches only the first, so a plan no longer written anywhere in the transcript
 * went on voting for continuation: at the next step limit `continueWhileWorkRemains` would say
 * "3 items left on the list" and spend another two hundred steps on its own.
 *
 * Re-read from the truncated log rather than cleared: a plan written before the cut still counts.
 */
function restorePlan({ log, state }: RewindParts): void {
	const plan = todosFromLog(log.messages);
	if (plan.length > 0) state.set(TODOS_KEY, plan);
	else state.delete(TODOS_KEY);
}

/**
 * Background sub-agents whose dispatch was cut off are stopped, and their results no longer
 * delivered.
 *
 * A cut during a turn goes through `abort` first, which stops them all. A cut while idle used not
 * to touch them, so a sub-agent dispatched in the discarded part of the history ran to the end,
 * delivered its report and opened a turn — the main session picking up work that never happened in
 * its history, and paying another turn for it. Dispatches still in the history are left alone:
 * someone is still waiting for those results.
 */
function stopCutDelegations({ log, deliveries, delegations, subAgents }: RewindParts): void {
	const dispatched = new Set<string>();
	for (const message of log.messages) {
		const id = message.role === "toolResult" ? (message.details as { subAgentId?: unknown } | undefined)?.subAgentId : undefined;
		if (typeof id === "string") dispatched.add(id);
	}
	// Ones already finished and waiting to be delivered are no longer in `delegations`; filter them separately.
	deliveries.keepOnly(dispatched);
	for (const id of delegations.forgetUnless((id) => dispatched.has(id))) subAgents.abort(id);
}
