import type { AgentEvent } from "@plume/core";

const readers = new Map<string, AgentEvent[]>();

export function beginSessionRead(id: string): AgentEvent[] {
	const events: AgentEvent[] = [];
	readers.set(id, events);
	return events;
}

export function endSessionRead(id: string): void { readers.delete(id); }

export function recordReadEvent(id: string, event: AgentEvent): void { readers.get(id)?.push(event); }
