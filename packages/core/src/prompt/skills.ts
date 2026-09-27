import type { Skill } from "../skills/loader.ts";

const METADATA_BUDGET = 20_000;
const DESCRIPTION_CHARS = 250;

/** Keep every skill discoverable; large catalogues lose descriptions, never names or locations. */
export function formatSkills(skills: Skill[]): string {
	const visible = skills.filter(skill => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const render = (descriptions: boolean) => [
		"", "",
		"The following skills provide specialized instructions for specific tasks.",
		"When a task matches a skill's description, call the `skill` tool with its name before starting your own approach — the skill's instructions replace your default plan for that task.",
		"When a skill references a relative path, resolve it against the skill's directory and use that absolute path in tool calls.",
		"", "<available_skills>",
		...visible.flatMap(skill => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			...(descriptions ? [`    <description>${escapeXml(shortDescription(skill.description))}</description>`] : []),
			`    <location>${escapeXml(skill.dir)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
	const full = render(true);
	return full.length <= METADATA_BUDGET ? full : render(false);
}

function shortDescription(text: string): string {
	const points = [...text];
	return points.length <= DESCRIPTION_CHARS ? text : `${points.slice(0, DESCRIPTION_CHARS - 1).join("")}…`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
