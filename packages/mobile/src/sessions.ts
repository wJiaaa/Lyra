import type { SessionMeta } from "@plume/client-runtime";

type Projects = readonly { id: string; name: string }[];

/**
 * 会话所在的项目现在叫什么。读项目列表里的名字，不读建会话时记下的文件夹名（`projectName`）：改过名的项目、
 * 两个都叫 app 的项目，手机上和桌面上要是同一种说法。不在项目里的会话叫它的文件夹名。
 */
export function projectLabel(projects: Projects, session: Pick<SessionMeta, "project" | "projectName">): string {
	return (session.project ? projects.find((project) => project.id === session.project)?.name : undefined) ?? session.projectName;
}

export function visibleSessions(sessions: SessionMeta[], query: string, filter: "all" | "running" | "archived", running: string[], projects: Projects = []): SessionMeta[] {
	const search = query.trim().toLocaleLowerCase();
	return sessions.filter((session) => filter === "archived" ? session.archived : !session.archived)
		.filter((session) => filter !== "running" || running.includes(session.id))
		.filter((session) => `${session.title} ${projectLabel(projects, session)}`.toLocaleLowerCase().includes(search))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type Bucket = "today" | "yesterday" | "week" | "earlier";
const DAY = 86_400_000;

/** 按本地日历日分组，不按「过去 24 小时」：昨晚十一点的会话今早看应当在「昨天」下面。 */
export function bucketOf(time: number, now: number): Bucket {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const start = midnight.getTime();
	if (time >= start) return "today";
	if (time >= start - DAY) return "yesterday";
	if (time >= start - 6 * DAY) return "week";
	return "earlier";
}

/** 已按时间倒序的列表切成连续的几段；段内顺序不动。 */
export function groupSessions(sessions: SessionMeta[], now: number): { bucket: Bucket; items: SessionMeta[] }[] {
	const groups: { bucket: Bucket; items: SessionMeta[] }[] = [];
	for (const session of sessions) {
		const bucket = bucketOf(session.updatedAt, now);
		const last = groups.at(-1);
		if (last?.bucket === bucket) last.items.push(session);
		else groups.push({ bucket, items: [session] });
	}
	return groups;
}

export type Ago = { key: "justNow" } | { key: "minutesAgo" | "hoursAgo"; n: number } | { key: "date"; date: Date };
export function ago(time: number, now: number): Ago {
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return { key: "justNow" };
	if (minutes < 60) return { key: "minutesAgo", n: minutes };
	if (bucketOf(time, now) === "today") return { key: "hoursAgo", n: Math.floor(minutes / 60) };
	return { key: "date", date: new Date(time) };
}
