/**
 * What a conversation is doing right now, as one word.
 *
 * The sidebar lists conversations that are not on screen, and several of them can be live at
 * once — a scheduled task runs in one, the phone drives another, an agent in a third has stopped
 * to ask permission and will wait indefinitely for an answer nobody knows it needs. From the
 * list, all of these look exactly like a conversation somebody finished last Tuesday.
 *
 * Derived from the event stream rather than stored: the events already say everything, and a
 * second source of truth would be a second thing to get wrong. Kept here, away from the window,
 * because it is a rule about what events mean and deserves to be tested as one.
 */

/** Absent means idle — nothing to say about it, which is true of most conversations. */
export type SessionActivity =
	/** A turn is in progress. */
	| "running"
	/** Stopped, and waiting for a person: an approval nobody has answered yet. */
	| "waiting"
	/** Finished since you last looked. */
	| "done"
	/** Ended badly since you last looked — an error, or the turn limit. */
	| "failed";

/** The subset of the event stream this cares about; anything else leaves the state alone. */
interface ActivityEvent {
	type: string;
	reason?: string;
	level?: string;
	command?: { status: string; automatic?: unknown };
}

/**
 * Fold one event into the activity of the conversation it came from.
 *
 * Returning `null` means idle, and idle is a real answer rather than "no information" — a turn
 * the user aborted themselves ends in nothing, because they know how it ended.
 */
export function nextActivity(event: ActivityEvent, current: SessionActivity | null): SessionActivity | null {
	switch (event.type) {
		case "command_status":
			if (event.command?.automatic) return current;
			return event.command?.status === "running" ? "running" : event.command?.status === "failed" ? "failed" : event.command?.status === "done" ? "done" : null;
		case "agent_start":
		case "turn_start":
			return "running";

		case "approval_request":
			return "waiting";

		/*
		 * Any sign of progress ends the wait.
		 *
		 * There is no "approval granted" event — permission is answered over a different channel
		 * and the agent simply carries on. What arrives next is the tool it was asking about, so
		 * that is what marks the conversation as moving again.
		 */
		case "tool_start":
		case "tool_end":
		case "message_start":
		case "message_update":
			return current === "waiting" ? "running" : current;

		case "agent_end":
			if (event.reason === "error" || event.reason === "max_turns") return "failed";
			// Aborted by the person who was watching it; they do not need to be told.
			if (event.reason === "aborted") return null;
			return "done";

		/*
		 * An error notice while a turn is running is a warning, not an outcome.
		 *
		 * The turn continues — a retry, a tool that failed and will be reported back to the model
		 * — and `agent_end` will say how it actually finished. Only an error outside a turn has
		 * nothing else coming to describe it.
		 */
		case "notice":
			return event.level === "error" && current !== "running" ? "failed" : current;

		default:
			return current;
	}
}

/**
 * What the list should show for a conversation, given whether it is the one on screen.
 *
 * Reading a result is what clears it. The conversation you are looking at cannot have an unread
 * outcome — the transcript is right there — so `done` and `failed` collapse to idle for it while
 * `running` and `waiting` still show, because those are about the future rather than the past.
 */
export function visibleActivity(activity: SessionActivity | null, isActive: boolean): SessionActivity | null {
	if (!activity) return null;
	if (!isActive) return activity;
	return activity === "running" || activity === "waiting" ? activity : null;
}
