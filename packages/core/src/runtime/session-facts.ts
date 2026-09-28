/**
 * The session as something to be read, not driven.
 *
 * Assembled explicitly rather than by making the session's fields public: describing a session
 * needs most of its state, and the way to give that away without also giving away the ability to
 * change it is to hand over a copy of the references and nothing else.
 */

import { join } from "node:path";
import type { Settings } from "../config/settings.ts";
import { lyraHome } from "../session/store.ts";
import type { SessionFacts } from "./reporting.ts";
import type { SessionCapabilities } from "./session-capabilities.ts";
import type { SessionLog } from "./session-log.ts";

export function sessionFacts(input: {
	log: SessionLog;
	can: SessionCapabilities;
	settings: Settings;
	cwd: string;
	running: boolean;
}): SessionFacts {
	const { log, can } = input;
	return {
		meta: log.meta,
		running: input.running,
		cwd: input.cwd,
		messages: log.messages,
		settings: input.settings,
		tools: can.tools,
		skills: can.skills,
		skillDiagnostics: can.skillDiagnostics,
		plugins: can.plugins,
		pluginDiagnostics: can.pluginDiagnostics,
		mcpStatuses: can.mcpStatuses,
		agents: can.agents,
		mcp: can.mcp,
		resources: can.resources.schemes(),
		requestContext: log.requestContext,
		readContext: () => log.readContext(),
		scratchDir: () => scratchDir(log.meta?.id),
	};
}

/**
 * Where the model can put files that are not part of the project.
 *
 * Named for the conversation so two of them cannot tread on each other, and sitting beside the
 * previews, which are removed on the same occasions and for the same reason.
 */
export function scratchDir(sessionId: string | undefined): string {
	return join(lyraHome(), "scratch", sessionId ?? "unsaved");
}
