/**
 * A runtime notice in the window's language.
 *
 * The loop used to send only a Chinese sentence: an English window that ran out of context read
 * 「上下文超出了模型的上限，正在压缩历史后重试。」. Notices now carry a code beside core's wording,
 * and the window says it from the catalogues; a notice without one is shown as written.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AgentEvent, NoticeCode } from "@plume/core";
import { MESSAGE_CATALOGS } from "../src/i18n/messages/index.ts";
import { activeLocale, setActiveLocale } from "../src/i18n/translate.ts";
import { compactText, configProblemText, noticeText } from "../src/lib/notice-text.ts";

const initial = activeLocale();
after(() => setActiveLocale(initial));

const notice = (code?: NoticeCode): Extract<AgentEvent, { type: "notice" }> => ({
	type: "notice",
	level: "warn",
	message: "上下文超出了模型的上限，正在压缩历史后重试。",
	...(code ? { code } : {}),
});

test("a coded notice follows the window's language", () => {
	setActiveLocale("en");
	assert.equal(noticeText(notice("context-overflow")), MESSAGE_CATALOGS.en["notice.context-overflow"]);
	assert.doesNotMatch(noticeText(notice("context-overflow")), /[一-鿿]/, "no Chinese left in the English window");
	setActiveLocale("zh-CN");
	assert.equal(noticeText(notice("context-overflow")), "上下文超出了模型的上限，正在压缩历史后重试。");
});

test("a notice without a code is shown as core wrote it", () => {
	setActiveLocale("en");
	assert.equal(noticeText(notice()), "上下文超出了模型的上限，正在压缩历史后重试。");
});

test("the Chinese catalogue says what core says, so switching languages changes nothing for a Chinese window", () => {
	const core: Partial<Record<NoticeCode, string>> = {
		"request-rejected": "模型服务拒收了这次请求。已把其中过大的工具输出压成一行，正在重试。",
		"context-overflow": "上下文超出了模型的上限，正在压缩历史后重试。",
		"output-limit": "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。",
		stalled: "同一个调用反复得到相同结果，已停下。告诉它换个方向，或直接说明你想怎么处理。",
		"side-model-unavailable": "侧边聊天指定的模型不可用，请重新选择。",
		"continue-planless": "这一段的轮数用完了，还没写清单——让它把剩下的步骤列出来，接着做。",
		"step-limit": "本轮已达到步数上限，已停下。执行记录已保留，需要时可继续。",
		"continue-limit": "已达到自动续跑次数上限，已停下。执行记录已保留，需要时可继续。",
		"prompt-blocked-silent": "UserPromptSubmit 钩子拦下了这条消息：未说明原因",
	};
	for (const [code, text] of Object.entries(core)) assert.equal(MESSAGE_CATALOGS["zh-CN"][`notice.${code as NoticeCode}`], text, code);
});

test("a notice's numbers and names are filled into the window's wording, with English plurals", () => {
	const plan = (n: number): Extract<AgentEvent, { type: "notice" }> => ({
		type: "notice", level: "info", message: `本轮步数用尽，清单里还有 ${n} 项，继续执行。`, code: "continue-plan", params: { n },
	});
	setActiveLocale("en");
	assert.equal(noticeText(plan(1)), "Out of steps with 1 checklist item left. Carrying on.");
	assert.equal(noticeText(plan(3)), "Out of steps with 3 checklist items left. Carrying on.");
	setActiveLocale("zh-CN");
	assert.equal(noticeText(plan(3)), plan(3).message, "the Chinese window reads exactly what core wrote");
});

test("a manual compaction's outcome follows the window's language, and an old record without a code is shown as written", () => {
	setActiveLocale("en");
	assert.equal(compactText({ code: "done", params: { before: 40, after: 9 } }, "已压缩上下文"), "Compacted. Messages: 40 → 9. The full conversation is still there to read.");
	assert.equal(compactText({ code: "failed", params: { error: "socket hang up" } }, "压缩失败"), "Compaction failed: socket hang up");
	assert.equal(compactText({}, "压缩失败：旧记录"), "压缩失败：旧记录");
	setActiveLocale("zh-CN");
	assert.equal(compactText({ code: "done", params: { before: 40, after: 9 } }, ""), "已压缩上下文：40 条消息整理为 9 条，完整对话仍可查看。");
});

test("a broken project config is described in the window's language", () => {
	setActiveLocale("en");
	assert.equal(configProblemText({ kind: "invalid-json", path: "/p/.plume/config.json", detail: "Unexpected token }" }, "x"), "/p/.plume/config.json isn't valid JSON: Unexpected token }");
	assert.equal(configProblemText(undefined, "core wording"), "core wording");
});
