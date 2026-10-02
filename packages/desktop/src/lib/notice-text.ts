/**
 * A runtime notice, in the window's language.
 *
 * Core names the situation with a code and keeps its own wording beside it for logs and the CLI
 * (ADR-0028). A notice with no code — a plugin's, or a situation this version does not know — is
 * shown as core wrote it.
 */

import type { AgentEvent } from "@plume/core";
import type { MessageKey } from "../i18n/messages/index.ts";
import { translate } from "../i18n/translate.ts";

export function noticeText(event: Extract<AgentEvent, { type: "notice" }>): string {
	return event.code ? translate(`notice.${event.code}` satisfies MessageKey) : event.message;
}
