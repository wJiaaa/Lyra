/**
 * The schemes that ship.
 *
 * Each is small because the router already did the parsing, the indexing and the range slicing.
 * What is left per handler is the part that is genuinely specific: where the bytes are, and what
 * counts as escaping.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expandSkillPaths, type Skill } from "../skills/loader.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { artifactResource, mcpResource, pluginResource, sessionResource } from "./more-handlers.ts";
import { plumeResource } from "./plume-docs.ts";
import { resolveInside, stillInside } from "./router.ts";
import { ResourceError, type Completion, type ParsedUrl, type Resource, type ResourceContext, type ResourceHandler } from "./types.ts";

/**
 * `skill://<name>` is the SKILL.md; `skill://<name>/<path>` is a file in its directory.
 *
 * Read-only. Reading a skill and activating one are different acts — the `skill` tool injects the
 * body as an instruction the model then follows, this returns text it is looking at — and they
 * both stay, because "consult" and "adopt" are not the same request.
 */
const skillResource: ResourceHandler = {
	scheme: "skill",
	/*
	 * Three forms, each paired with what it is for.
	 *
	 * The first draft led with "技能正文" and listed the forms after, and a weaker model read that
	 * as "a skill is a directory" — it went looking for `skill://pdf-extract/README.md`, a file
	 * nobody had mentioned, then fell back to guessing filenames on disk. Naming the bare form
	 * first, explicitly, is the difference between three affordances and one guess.
	 */
	describe: "`skill://<名字>` 是技能正文本身；`skill://<名字>/` 列出它的目录里有什么；`skill://<名字>/<文件名>` 读目录里的某个文件",

	async resolve(url: ParsedUrl, ctx: ResourceContext): Promise<Resource> {
		const skills = (ctx.state.get(SKILLS_KEY) as Skill[] | undefined) ?? [];
		const [name, ...rest] = url.segments;
		const skill = skills.find((s) => s.name === name);
		if (!skill) {
			const available = skills.map((s) => s.name).join("、");
			throw new ResourceError(`没有叫“${name}”的技能。现有的是：${available || "（一个都没有）"}`);
		}

		/*
		 * A trailing slash asks what is in the directory, not what the skill says.
		 *
		 * Without this the address space has no answer to "what files does this skill have", and a
		 * model that wants one falls back to walking the filesystem — which it did, and guessed the
		 * wrong extension on the way. An address space that covers reading but not listing sends
		 * people back to paths for half their questions, which is most of the value gone.
		 */
		if (rest.length === 0 && url.path.endsWith("/")) {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(skill.dir, { withFileTypes: true }).catch(() => []);
			const listing = entries
				.map((entry) => `- skill://${skill.name}/${entry.name}${entry.isDirectory() ? "/" : ""}`)
				.join("\n");
			return {
				url: url.raw,
				content: listing || `（技能“${skill.name}”的目录里没有别的文件）`,
				contentType: "text/markdown",
				label: `技能“${skill.name}”目录里的全部文件`,
				meta: { name: skill.name, dir: skill.dir },
			};
		}

		if (rest.length === 0) {
			return {
				url: url.raw,
				// 同 `skill` 工具交给模型的那份一样，路径变量已经填好——见 `expandSkillPaths`。
				content: expandSkillPaths(skill),
				contentType: "text/markdown",
				label: `技能“${skill.name}”的完整正文`,
				meta: { name: skill.name, dir: skill.dir, source: skill.source },
			};
		}

		const target = resolveInside(skill.dir, rest.join("/"));
		if (!target) throw new ResourceError(`\`${url.raw}\` 指到了技能目录外面。`);
		if (!(await stillInside(skill.dir, target))) throw new ResourceError(`\`${url.raw}\` 经过软链后指到了技能目录外面。`);

		const content = await readFile(target, "utf8").catch(() => null);
		if (content === null) throw new ResourceError(`技能“${name}”里没有 ${rest.join("/")}。`);
		return {
			url: url.raw,
			content,
			contentType: "text/plain",
			label: `技能“${name}”目录里 ${rest.join("/")} 的完整内容`,
			meta: { name: skill.name, file: target },
		};
	},

	async list(ctx: ResourceContext): Promise<Completion[]> {
		const skills = (ctx.state.get(SKILLS_KEY) as Skill[] | undefined) ?? [];
		return skills.map((s) => ({ value: `skill://${s.name}`, description: s.description }));
	},
};

/**
 * `scratch://<path>` is the session's own directory. The one writable scheme.
 *
 * It already existed as a bare filesystem path the prompt told the model about, which meant the
 * model had to be trusted to keep using it — and a path in a prompt is a suggestion. As an address
 * it is a place, and `write scratch://notes.md` cannot land in the user's project by mistake.
 */
const scratchResource: ResourceHandler = {
	scheme: "scratch",
	describe: "本次会话的临时目录，可读可写（write、edit 都能用），随会话删除一起清掉",

	async resolve(url: ParsedUrl, ctx: ResourceContext): Promise<Resource> {
		const target = await scratchTarget(url, ctx);
		const content = await readFile(target, "utf8").catch(() => null);
		if (content === null) throw new ResourceError(`临时目录里没有 ${url.path}。`);
		return { url: url.raw, content, contentType: "text/plain", meta: { file: target } };
	},

	async write(url: ParsedUrl, content: string, ctx: ResourceContext): Promise<void> {
		// 先查真实落点再建目录：顺着软链先在外面把目录建出来，查出来也晚了。
		const target = await scratchTarget(url, ctx);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	},

	async list(ctx: ResourceContext): Promise<Completion[]> {
		if (!ctx.scratchDir) return [];
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(ctx.scratchDir, { withFileTypes: true }).catch(() => []);
		return entries.filter((e) => e.isFile()).map((e) => ({ value: `scratch://${e.name}` }));
	},
};

/**
 * 临时目录里的一条路径，字面和真实落点都得在目录里。
 *
 * 这是唯一可写的 scheme，读写都不经过文件授权：目录里一条指向外面的软链，就能让 `write` 覆盖或新建
 * 用户的任何文件、`read` 读走任何文件，而审批一次都不会被问到。
 */
export async function scratchTarget(url: ParsedUrl, ctx: ResourceContext): Promise<string> {
	if (!ctx.scratchDir) throw new ResourceError("这个会话没有临时目录。");
	const target = resolveInside(ctx.scratchDir, url.segments.join("/"));
	if (!target) throw new ResourceError(`\`${url.raw}\` 指到了临时目录外面。`);
	if (!(await stillInside(ctx.scratchDir, target))) throw new ResourceError(`\`${url.raw}\` 经过软链后指到了临时目录外面。`);
	return target;
}

/**
 * `agent://<id>` is a sub-agent's structured result; `agent://<id>/<path>` is one field of it.
 *
 * The reason for the path half: in an orchestration with eight sub-agents, a parent that wants one
 * value has to re-read a whole reply to get it, and does that eight times. `agent://sub-a1b2/
 * files.0.path` is the value.
 *
 * The path syntax is `a.b.0.c` and nothing more. JSONPath expressions (`$..[?(@.x)]`) are a second
 * language, and the cost of a model learning it exceeds what it buys over reading one more field.
 */
const agentResource: ResourceHandler = {
	scheme: "agent",
	describe: "`agent://<id>` 子代理交回的结构化结果；`agent://<id>/<字段路径>` 取其中一个字段（如 `files.0.path`）",

	async resolve(url: ParsedUrl, ctx: ResourceContext): Promise<Resource> {
		const registry = ctx.state.get(SUBAGENTS_KEY) as SubAgentLookup | undefined;
		if (!registry) throw new ResourceError("这个会话没有子代理。");

		const [id, ...rest] = url.segments;
		/*
		 * Accept a suffix as well as the full id.
		 *
		 * The id is `<session>:sub:<8 hex>`, and what appears in the transcript and what a person
		 * types is the short tail. Resolving through `detail` in both cases matters: `list` returns
		 * summaries, which carry no structured output, and taking one of those would report every
		 * short-form address as having no result.
		 */
		const match = registry.detail(id) ?? (() => {
			const found = registry.list().find((r) => r.id.endsWith(id));
			return found ? registry.detail(found.id) : null;
		})();
		const record = match;
		if (!record) {
			const known = registry.list().map((r) => r.id).join("、");
			throw new ResourceError(`没有 id 是“${id}”的子代理。现有的是：${known || "（一个都没有）"}`);
		}
		if (!record.output) {
			/*
			 * A sub-agent without a declared schema returns prose, and that is not a failure — so the
			 * text is handed over rather than an error. Saying "this one has no structured output"
			 * and stopping would send the parent looking for a way to get it, and there is not one.
			 */
			return {
				url: url.raw,
				content: record.answer ?? "（这个子代理还没有结果）",
				contentType: "text/plain",
				label: `子代理 ${record.agent} 的回复（这个 agent 没有声明结构化输出，所以是文本）`,
				meta: { id: record.id, agent: record.agent, status: record.status },
			};
		}

		if (rest.length === 0) {
			return {
				url: url.raw,
				content: JSON.stringify(record.output, null, 2),
				contentType: "application/json",
				label: `子代理 ${record.agent} 的完整结果`,
				meta: { id: record.id, agent: record.agent, status: record.status, warnings: record.warnings },
			};
		}

		const picked = pickPath(record.output, rest.join("/").split("."));
		if (picked === undefined) {
			throw new ResourceError(`子代理 ${record.id} 的结果里没有 \`${rest.join("/")}\`。可用的顶层字段：${Object.keys(record.output).join("、")}`);
		}
		return {
			url: url.raw,
			content: typeof picked === "string" ? picked : JSON.stringify(picked, null, 2),
			contentType: typeof picked === "string" ? "text/plain" : "application/json",
			label: `子代理 ${record.agent} 结果里的 ${rest.join("/")}`,
			meta: { id: record.id, agent: record.agent },
		};
	},

	async list(ctx: ResourceContext): Promise<Completion[]> {
		const registry = ctx.state.get(SUBAGENTS_KEY) as SubAgentLookup | undefined;
		if (!registry) return [];
		return registry.list().map((r) => ({ value: `agent://${r.id}`, description: `${r.agent} · ${r.description} · ${r.status}` }));
	},
};

/** Only what `agent://` needs, so this file does not depend on the registry's whole shape. */
interface SubAgentLookup {
	list(): { id: string; agent: string; description: string; status: string }[];
	detail(id: string): {
		id: string;
		agent: string;
		status: string;
		answer?: string;
		output?: Record<string, unknown>;
		warnings?: string[];
	} | null;
}

export const SUBAGENTS_KEY = "subAgentRegistry";

/** Walk `a.b.0.c`. Anything the path does not fit returns undefined rather than throwing. */
function pickPath(root: unknown, segments: string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current.at(index);
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * The shipped schemes.
 *
 * `agent://` is in the list but contributes nothing until a session registers a sub-agent registry,
 * which is what keeps it out of the prompt for sessions that cannot dispatch — an advertised
 * address that never resolves teaches the model to try things that fail.
 */
export const BUILTIN_RESOURCES: ResourceHandler[] = [
	skillResource,
	scratchResource,
	plumeResource,
	agentResource,
	sessionResource,
	pluginResource,
	mcpResource,
	artifactResource,
];
