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
import { noticeText } from "../src/lib/notice-text.ts";

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
	};
	for (const [code, text] of Object.entries(core)) assert.equal(MESSAGE_CATALOGS["zh-CN"][`notice.${code as NoticeCode}`], text, code);
});
