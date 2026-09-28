import type { SessionMeta } from "@plume/core";

export type SessionSortKey = "updatedAt" | "createdAt" | "manual";

/** Reading and dragging must start from the same order, including newly created sessions. */
export function orderedSessions(sessions: SessionMeta[], sort: SessionSortKey, custom: string[] = []): SessionMeta[] {
	const rank = new Map(custom.map((id, index) => [id, index]));
	return [...sessions].sort((a, b) => {
		if (sort === "manual") {
			const left = rank.get(a.id) ?? -1;
			const right = rank.get(b.id) ?? -1;
			if (left !== right) return left - right;
		}
		const field = sort === "createdAt" ? "createdAt" : "updatedAt";
		return b[field] - a[field];
	});
}

export function moveBeforeOrAfter<T>(items: T[], source: T, target: T, placement: "before" | "after"): T[] | null {
	if (source === target || !items.includes(source) || !items.includes(target)) return null;
	const next = items.filter((item) => item !== source);
	next.splice(next.indexOf(target) + (placement === "after" ? 1 : 0), 0, source);
	return next.every((item, index) => item === items[index]) ? null : next;
}
