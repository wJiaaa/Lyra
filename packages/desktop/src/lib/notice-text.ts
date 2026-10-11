/**
 * What the runtime reports, in the window's language.
 *
 * Core names the situation with a code and keeps its own wording beside it for logs and the CLI
 * (ADR-0028). Anything with no code — a plugin's notice, a record written before codes existed, a
 * situation this version does not know — is shown as core wrote it.
 */

import type { AgentEvent, CompactCode, ConfigProblem, GoalPauseReason, NoticeParams } from "@plume/core";
import type { MessageKey } from "../i18n/messages/index.ts";
import { translate } from "../i18n/translate.ts";

export function noticeText(event: Extract<AgentEvent, { type: "notice" }>): string {
	if (!event.code) return event.message;
	// 停下的原因 core 给的是代号（`budget`），句子里要的是人话。
	const params = event.code === "goal-paused" ? { ...event.params, why: goalPauseText(event.params?.why) } : event.params;
	return translate(`notice.${event.code}` satisfies MessageKey, params);
}

const PAUSE_REASONS: readonly GoalPauseReason[] = ["budget", "no-progress", "judge-failed", "stopped", "error", "user"];

/** 持续目标为什么停下，说给人听。认不出的代号原样给出，好过一句空话。 */
export function goalPauseText(why: unknown): string {
	const known = PAUSE_REASONS.find((reason) => reason === why);
	return known ? translate(`goal.pause.${known}` satisfies MessageKey) : String(why ?? "");
}

/** A manual `/compact`'s outcome: the line under the command, or the toast when it was refused. */
export function compactText(said: { code?: CompactCode; params?: NoticeParams }, fallback: string): string {
	return said.code ? translate(`compactNote.${said.code}` satisfies MessageKey, said.params) : fallback;
}

/** What is wrong with a project's `.plume/config.json`. */
export function configProblemText(problem: ConfigProblem | undefined, fallback: string): string {
	if (problem?.kind === "not-object") return translate("notice.project-config-not-object", { path: problem.path });
	if (problem?.kind === "invalid-json") return translate("notice.project-config-invalid-json", { path: problem.path, error: problem.detail });
	return fallback;
}
