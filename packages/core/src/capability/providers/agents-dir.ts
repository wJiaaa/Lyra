/**
 * `.agent/` 与 `.agents/`：一个跨工具的社区约定。
 *
 * 不属于任何一家的目录名，几家都认。我们读其中的 `skills/`、`commands/`、`AGENTS.md`——
 * 这三个 loader 早就有了，这里只是告诉它们去哪儿读。
 *
 * 两个目录名都读。写这份约定的人自己没定下来用哪个，于是两个都在野外流通；只认一个，
 * 另一半的人就静默失效。
 *
 * 项目侧向上遍历到仓库根——一个 monorepo 的根和子包各放一个 `.agents/`，都该生效。
 * 用户侧 `~/.agent(s)/` 的命令默认不读，跟别家的个人目录同一个道理：它跟着你进别人的仓库，
 * 会做出一个跟同事在同一份代码上行为不同的 agent。技能例外，`~/.agents/skills` 一直读：技能
 * 只在模型判断用得上时才展开，而这是几家工具共用的个人技能目录，不读就得
 * 在每个工具里各装一遍。只认复数，单数的 `~/.agent/` 在个人侧没有这个共识。
 */

import { join } from "node:path";
import { loadCommands } from "../../commands/loader.ts";
import { loadSkills } from "../../skills/loader.ts";
import type { CapabilityId, CapabilityProvider, ContextFile, DiscoveryContext, ProviderResult, SourceMeta, Sourced } from "../types.ts";

const ID = "agents-dir";
const LABEL = "Agents 标准";
const DIR_NAMES = [".agent", ".agents"];

/** 一个找到的目录，带它离 cwd 几层、是项目的还是个人的。 */
interface Found {
	dir: string;
	scope: "project" | "user";
	depth: number;
}

/**
 * 项目侧从 cwd 往上到仓库根，每层看两个名字；用户侧只看 `userNames` 里的。
 *
 * 目录不存在不是错误，是常态——绝大多数项目没有 `.agents/`。这里不 stat，交给各个 loader
 * 自己处理不存在的目录（它们本来就得处理）。
 */
async function candidates(ctx: DiscoveryContext, userNames: readonly string[]): Promise<Found[]> {
	const { dirname } = await import("node:path");
	const found: Found[] = [];

	if (ctx.cwd) {
		let dir = ctx.cwd;
		for (let depth = 0; depth < 10; depth += 1) {
			for (const name of DIR_NAMES) found.push({ dir: join(dir, name), scope: "project", depth });
			if (ctx.repoRoot === null || dir === ctx.repoRoot) break;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	for (const name of userNames) found.push({ dir: join(ctx.userHome, name), scope: "user", depth: 0 });
	return found;
}

function meta(path: string, at: Found): SourceMeta {
	return { provider: ID, providerLabel: LABEL, path, scope: at.scope, depth: at.scope === "project" ? at.depth : undefined };
}

export const agentsDirProvider: CapabilityProvider = {
	id: ID,
	label: LABEL,
	describe: "读取 .agent/ 与 .agents/（技能、命令、AGENTS.md），项目侧向上到仓库根；个人侧只读技能",
	/** 45：它是一个泛约定，排在各家工具自己的目录之下。 */
	priority: 45,
	supplies: ["skill", "command", "context-file"],
	foreign: true,

	async load(kind: CapabilityId, ctx: DiscoveryContext): Promise<ProviderResult> {
		const dirs = await candidates(ctx, ctx.userSourceEnabled ? DIR_NAMES : kind === "skill" ? [".agents"] : []);
		if (dirs.length === 0) return { items: [] };

		if (kind === "skill") {
			const items: Sourced<unknown>[] = [];
			const diagnostics: ProviderResult["diagnostics"] = [];
			const watched: string[] = [];
			for (const at of dirs) {
				const dir = join(at.dir, "skills");
				watched.push(dir);
				const loaded = await loadSkills([{ dir, source: at.scope === "project" ? "workspace" : "user" }]);
				items.push(...loaded.skills.map((skill) => ({ ...skill, provenance: meta(skill.path, at) }) as Sourced<unknown>));
				diagnostics.push(...loaded.diagnostics.map((d) => ({ path: d.path, message: d.message, severity: "warning" as const })));
			}
			return { items, diagnostics, watched };
		}

		if (kind === "command") {
			const sources = dirs.map((at) => ({ dir: join(at.dir, "commands"), scope: at.scope === "project" ? ("workspace" as const) : ("user" as const), origin: "agents" as const, at }));
			const { commands, diagnostics } = await loadCommands(sources);
			return {
				items: commands.map((command) => {
					const at = sources.find((s) => command.path.startsWith(s.dir))?.at ?? dirs[0];
					return { ...command, provenance: meta(command.path, at) } as Sourced<typeof command>;
				}),
				diagnostics: diagnostics.map((d) => ({ path: d.path, message: d.message, severity: "warning" as const })),
				watched: sources.map((s) => s.dir),
			};
		}

		if (kind === "context-file") {
			/*
			 * `.agents/AGENTS.md` 跟同一层的裸 `AGENTS.md` 撞 `scope:depth` 这个 key。`native` 的
			 * 优先级 100 赢——根目录那份是更标准的位置——而这份是「被遮蔽」，设置页看得见。
			 */
			const { readFile } = await import("node:fs/promises");
			const { relative } = await import("node:path");
			const items: Sourced<ContextFile>[] = [];
			for (const at of dirs) {
				if (at.scope !== "project") continue;
				const path = join(at.dir, "AGENTS.md");
				const content = await readFile(path, "utf8").catch(() => null);
				if (!content?.trim()) continue;
				const file: ContextFile = { name: ctx.repoRoot ? relative(ctx.repoRoot, path) : path, path, content: content.trim(), scope: "project", depth: at.depth };
				items.push({ ...file, provenance: meta(path, at) } as Sourced<ContextFile>);
			}
			return { items, watched: dirs.filter((at) => at.scope === "project").map((at) => at.dir) };
		}

		return { items: [] };
	},
};
