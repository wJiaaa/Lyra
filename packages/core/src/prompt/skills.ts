import type { Skill } from "../skills/loader.ts";

const METADATA_BUDGET = 20_000;
const DESCRIPTION_CHARS = 250;

/**
 * Keep every skill discoverable; large catalogues lose descriptions, never names.
 *
 * 一行一条，不带目录：目录在加载时由 `formatSkillInvocation` 给出，那里才用得上。以前每条包一层
 * XML 再附上绝对路径，19 个技能里三分之一的字符是标签和路径，每次请求都发。
 */
export function formatSkills(skills: Skill[]): string {
	const visible = skills.filter(skill => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const render = (descriptions: boolean) => [
		"", "",
		"When a task matches one of these skills, call the `skill` tool with its name before starting your own approach — its instructions replace your default plan for that task.",
		"", "<available_skills>",
		...visible.map(skill => descriptions
			? `- ${escapeXml(skill.name)}: ${escapeXml(shortDescription(skill.description))}`
			: `- ${escapeXml(skill.name)}`),
		"</available_skills>",
	].join("\n");
	const full = render(true);
	return full.length <= METADATA_BUDGET ? full : render(false);
}

function shortDescription(text: string): string {
	// One line per skill, so a multi-line description is folded onto it.
	const points = [...text.replace(/\s+/g, " ").trim()];
	return points.length <= DESCRIPTION_CHARS ? points.join("") : `${points.slice(0, DESCRIPTION_CHARS - 1).join("")}…`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
