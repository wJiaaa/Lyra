/**
 * What the runtime reports, in the window's language.
 *
 * Core names the situation with a code and keeps its own wording beside it for logs and the CLI
 * (ADR-0028). Anything with no code — a plugin's notice, a record written before codes existed, a
 * situation this version does not know — is shown as core wrote it.
 */

import type { AgentEvent, CompactCode, ConfigProblem, NoticeParams } from "@plume/core";
import type { MessageKey } from "../i18n/messages/index.ts";
import { translate } from "../i18n/translate.ts";

export function noticeText(event: Extract<AgentEvent, { type: "notice" }>): string {
	return event.code ? translate(`notice.${event.code}` satisfies MessageKey, event.params) : event.message;
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
