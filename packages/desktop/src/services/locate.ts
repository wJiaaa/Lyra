/**
 * 一条相对路径在项目里唯一对应的文件，见 `electron/file-locate.ts`。回复里的文件链接和终端里的路径都从这里问。
 *
 * 只认唯一的匹配：两个 `tool-run.ts` 时挑哪个都是猜，猜错了点开的是另一份代码，比读不到更糟。
 */

import { bridge } from "./bridge.ts";

/*
 * 找到了的一直记着：同一条路径在长对话里出现多次、滚出去再滚回来都会再问。没找到的只记几秒——可能只是
 * 文件还没写出来（回复里先提、随后才建），记死了就再也点不开；而终端每次悬停一行都会问一遍，不记会
 * 一直起 git。
 */
const found = new Map<string, string>();
const missed = new Map<string, number>();
const pending = new Map<string, Promise<string | null>>();
const MISS_TTL = 5_000;

const keyOf = (project: string, relative: string) => `${project}\0${relative}`;

/** 已经找到过的，同步拿；没有就是 null。 */
export function locatedFile(project: string, relative: string): string | null {
	return found.get(keyOf(project, relative)) ?? null;
}

export function locateFile(project: string, relative: string): Promise<string | null> {
	const key = keyOf(project, relative);
	const hit = found.get(key);
	if (hit) return Promise.resolve(hit);
	const at = missed.get(key);
	if (at !== undefined && Date.now() - at < MISS_TTL) return Promise.resolve(null);
	let ask = pending.get(key);
	if (!ask) {
		// 从 `then` 里调：桥上没有这扇门（测试、只读的窗口）时同步抛的错也落到「没找到」。
		ask = Promise.resolve()
			.then(() => bridge.files.locate(project, relative))
			.then((matches) => (matches.length === 1 ? matches[0] : null), () => null)
			.then((path) => {
				pending.delete(key);
				if (path) found.set(key, path);
				else missed.set(key, Date.now());
				return path;
			});
		pending.set(key, ask);
	}
	return ask;
}
