/**
 * Which agents can actually install a given thing.
 *
 * This registry is not tied to one client, and that is a fact about the formats rather than a
 * marketing position. `SKILL.md` is a convention Claude Code established and Codex, Pi and Plume all
 * read; `.mcp.json` describes an MCP server, and MCP is a protocol with many clients. A directory
 * of skills genuinely does install into all of them.
 *
 * What is *not* portable is a plugin manifest: `.claude-plugin/` and `.lyra-plugin/` are each one
 * product's format. So compatibility is neither "everything" nor "whatever the author ticked" — it
 * is read off the archive, the same way `kind` is, and for the same reason: a claim in a form is a
 * claim, and this one would be wrong the moment somebody copied a submission template.
 */

import type { BundleKind } from "./entry.ts";

/** A client that can install something from here. `mcp` is the protocol, not one product. */
export type ClientId = "claude-code" | "codex" | "lyra" | "pi" | "mcp";

export const CLIENTS: readonly ClientId[] = ["claude-code", "codex", "pi", "lyra", "mcp"];

export function isClientId(value: unknown): value is ClientId {
	return CLIENTS.includes(value as ClientId);
}

/** Display names, in one place because they appear on cards, on detail pages and in the API. */
export const CLIENT_LABEL: Record<ClientId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	pi: "Pi",
	lyra: "Plume",
	mcp: "任何 MCP 客户端",
};

/**
 * Where each client keeps the thing, once installed.
 *
 * Shown on the detail page so somebody can install by hand — which is the honest fallback for
 * every client that has no marketplace of its own, and that is most of them.
 */
export const CLIENT_SKILL_PATH: Partial<Record<ClientId, string>> = {
	"claude-code": "~/.claude/skills/",
	codex: "~/.codex/skills/",
	pi: "~/.pi/skills/",
	lyra: "~/.plume/skills/",
};

export interface Evidence {
	/** At least one `<name>/SKILL.md`, which is the portable format. */
	skills: boolean;
	/** A `.mcp.json` declaring servers. */
	mcp: boolean;
	/** `.claude-plugin/` — Claude Code's own plugin layout. */
	claudePlugin: boolean;
	/** `.lyra-plugin/` — Plume's. */
	lyraPlugin: boolean;
	/** `.codex-plugin/` — read separately rather than inferred from Plume's, see `clientsFor`. */
	codexPlugin: boolean;
}

/**
 * Which clients this archive works with, from what it contains.
 *
 * Skills are the portable case: every agent listed reads a directory of `SKILL.md` folders. An MCP
 * server is reported as `mcp` rather than as a list of products, because the set of MCP clients is
 * open and naming five would quietly imply the sixth does not work.
 *
 * `kind` is a parameter because a plugin manifest only says something when the thing *is* a plugin.
 * Context7 is a `.mcp.json` and a `.lyra-plugin/` directory holding a name, an icon and a
 * description — metadata, not a plugin — and reading that directory as evidence had it advertised
 * as installable into Codex and Plume as a plugin, which it is not. Measured on the live catalogue:
 * three of five entries were labelled wrong.
 *
 * Returns an empty list rather than guessing when nothing recognisable is present. An entry
 * claiming universal compatibility on no evidence is worse than one claiming none.
 */
export function clientsFor(kind: BundleKind, evidence: Evidence): ClientId[] {
	const found = new Set<ClientId>();

	if (evidence.skills) {
		for (const client of ["claude-code", "codex", "pi", "lyra"] as const) found.add(client);
	}
	if (evidence.mcp) found.add("mcp");

	if (kind === "plugin") {
		if (evidence.claudePlugin) found.add("claude-code");
		if (evidence.lyraPlugin) found.add("lyra");
		// Not inferred from `.lyra-plugin/`. Plume's loader happens to accept either directory name,
		// which says what Plume reads and nothing about what Codex installs.
		if (evidence.codexPlugin) found.add("codex");
	}

	return CLIENTS.filter((client) => found.has(client));
}

/** Parse the comma-separated form stored in the database. Unknown values are dropped. */
export function parseClients(raw: string | null | undefined): ClientId[] {
	if (!raw) return [];
	const wanted = new Set(raw.split(",").map((part) => part.trim()));
	return CLIENTS.filter((client) => wanted.has(client));
}

export function serialiseClients(clients: ClientId[]): string {
	return CLIENTS.filter((client) => clients.includes(client)).join(",");
}
