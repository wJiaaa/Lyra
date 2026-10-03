/**
 * What the settings allow a run's tools to do, derived once for every kind of run.
 *
 * The main session and each sub-agent used to derive these field by field, in two places that had
 * to be kept in step by hand; a field added to one and missed in the other runs the sub-agent under
 * a different policy without a word. Spread this into the run's config instead.
 */

import type { AgentRunConfig } from "../agent/run-config.ts";
import { projectRootsFor } from "../config/project-roots.ts";
import type { Settings } from "../config/settings.ts";
import { sandboxModeFor } from "../sandbox/mode-for.ts";

export type ToolPolicy = Pick<AgentRunConfig, "sandboxMode" | "sandboxNetwork" | "allowedHosts" | "searchProviderId" | "projectRoots">;

export function toolPolicy(settings: Settings, cwd: string): ToolPolicy {
	return {
		/*
		 * Derived per run rather than read from settings by each tool: the mode cannot change halfway
		 * through a command, and a tool that looked it up itself could disagree with the one beside it.
		 */
		sandboxMode: sandboxModeFor(settings.permissionMode),
		// The network half, stated rather than derived: no permission mode implies it.
		sandboxNetwork: settings.denyCommandNetwork ? "deny" : "allow",
		allowedHosts: settings.allowedHosts,
		searchProviderId: settings.searchProvider ?? null,
		projectRoots: projectRootsFor(settings.projects, cwd),
	};
}
