import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMeta } from "@plume/client-runtime";
import { ago, bucketOf, groupSessions, visibleSessions } from "../src/sessions.ts";
import { translate } from "../src/i18n.ts";

test("会话筛选保持项目搜索、运行状态和归档隔离", () => {
	const sessions = [{ id: "one", title: "Fix", projectName: "Plume", updatedAt: 2 }, { id: "two", title: "Older", projectName: "Plume", updatedAt: 1, archived: true }] as SessionMeta[];
	assert.deepEqual(visibleSessions(sessions, "plume", "all", []).map((item) => item.id), ["one"]);
	assert.equal(visibleSessions(sessions, "", "running", []).length, 0);
	assert.equal(visibleSessions(sessions, "", "running", ["one"])[0]?.id, "one");
	assert.equal(visibleSessions(sessions, "", "archived", [])[0]?.id, "two");
	assert.equal(translate("zh")("send"), "发送消息");
	assert.equal(translate("en")("send"), "Send message");
	assert.equal(translate("zh")("countOf", { kind: "读取文件", n: 3 }), "读取文件 3 个");
});

test("会话按本地日历日分段，不按过去 24 小时", () => {
	const now = new Date(2026, 9, 8, 9, 0).getTime();
	assert.equal(bucketOf(new Date(2026, 9, 8, 0, 5).getTime(), now), "today");
	// 昨晚 23 点距现在只有 10 小时，但它属于昨天。
	assert.equal(bucketOf(new Date(2026, 9, 7, 23, 0).getTime(), now), "yesterday");
	assert.equal(bucketOf(new Date(2026, 9, 3, 12, 0).getTime(), now), "week");
	assert.equal(bucketOf(new Date(2026, 8, 20).getTime(), now), "earlier");
	const at = (day: number, id: string) => ({ id, updatedAt: new Date(2026, 9, day, 8).getTime() }) as SessionMeta;
	const groups = groupSessions([at(8, "a"), at(8, "b"), at(7, "c"), at(1, "d")], now);
	assert.deepEqual(groups.map((group) => [group.bucket, group.items.map((item) => item.id)]), [["today", ["a", "b"]], ["yesterday", ["c"]], ["earlier", ["d"]]]);
});

test("相对时间：一小时内按分钟，今天按小时，更早给日期", () => {
	const now = new Date(2026, 9, 8, 15, 0).getTime();
	assert.deepEqual(ago(now - 20_000, now), { key: "justNow" });
	assert.deepEqual(ago(now - 5 * 60_000, now), { key: "minutesAgo", n: 5 });
	assert.deepEqual(ago(now - 3 * 3_600_000, now), { key: "hoursAgo", n: 3 });
	assert.equal(ago(new Date(2026, 9, 7, 15).getTime(), now).key, "date");
});
