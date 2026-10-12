/**
 * 一个子代理的上下文用量：和主会话那只表同一套算法（`buildContextBreakdown`），换成它自己的输入。
 *
 * 它的系统提示词和工具表只在每段开跑时作为 `subagent_event` 里的 `context` 发一次，登记簿不留——那是
 * 日志里最占地方的一类记录，打开会话时 `subAgentRecords` 特意不读（见 `session/store.ts`）。所以跑着的
 * 从事件里顺手记下；重启之前派的，第一次问到时从日志里找一遍，之后就记着。
 */

import type { AgentEvent } from "../../agent/events.ts";
import type { Settings } from "../../config/settings.ts";
import type { SessionRecord } from "../../session/types.ts";
import type { ModelConfig, ToolSpec } from "../../types.ts";
import { buildContextBreakdown, type ContextBreakdown } from "../context.ts";
import type { SubAgentDetail } from "./sub-agents.ts";

type ContextEvent = Extract<AgentEvent, { type: "context" }>;

interface Seen {
	context?: ContextEvent;
	/** 它最近一段跑在哪个模型上，`subagent` 事件写着。 */
	ran?: { provider?: string; model?: string };
}

/**
 * 记多少个。每份带着整段系统提示词和工具表，几十 KB；一个长会话能派上百个，而有人点开看的只是最近
 * 那几个。挤出去的再问到时从日志里重读，只是慢一点。
 */
const KEPT = 32;

export class SubAgentContexts {
	private readonly seen = new Map<string, Seen>();

	observe(event: AgentEvent): void {
		if (event.type === "subagent") this.entry(event.id).ran = { provider: event.provider, model: event.model };
		else if (event.type === "subagent_event" && event.event.type === "context") this.entry(event.id).context = event.event;
	}

	async get(id: string, read: () => AsyncIterable<SessionRecord>): Promise<Seen> {
		const known = this.seen.get(id);
		if (known?.context) return known;
		const found: Seen = {};
		for await (const record of read()) {
			if (record.type !== "event") continue;
			const event = record.event;
			if (event.type === "subagent" && event.id === id) found.ran = { provider: event.provider, model: event.model };
			else if (event.type === "subagent_event" && event.id === id && event.event.type === "context") found.context = event.event;
		}
		// 读日志这段时间里它可能又开了一段：那是更新的，留它。
		const live = this.seen.get(id);
		const merged = { context: live?.context ?? found.context, ran: live?.ran ?? found.ran };
		if (merged.context) this.remember(id, merged);
		return merged;
	}

	private entry(id: string): Seen {
		const known = this.seen.get(id);
		if (known) return known;
		return this.remember(id, {});
	}

	private remember(id: string, seen: Seen): Seen {
		this.seen.delete(id);
		this.seen.set(id, seen);
		if (this.seen.size > KEPT) this.seen.delete(this.seen.keys().next().value!);
		return seen;
	}
}

export function describeSubAgentContext(input: {
	detail: SubAgentDetail;
	seen: Seen;
	settings: Settings;
	/** 它的模型已经不在设置里时，按派它的那个会话的模型量——窗口总得有个上限。 */
	fallback: ModelConfig | undefined;
	mcpNames: Set<string>;
}): ContextBreakdown | null {
	const { context, ran } = input.seen;
	if (!context) return null;
	const provider = input.settings.providers.find((one) => one.enabled && one.id === ran?.provider);
	const model = provider?.models.find((one) => one.modelId === ran?.model) ?? input.fallback;
	if (!model) return null;
	const schemas: ToolSpec[] = context.schemas ?? [];
	return buildContextBreakdown({
		model,
		messages: input.detail.messages,
		systemPrompt: context.systemPrompt,
		sections: context.sections,
		builtinTools: schemas.filter((tool) => !input.mcpNames.has(tool.name)),
		mcpTools: schemas.filter((tool) => input.mcpNames.has(tool.name)),
		skillCatalogue: "",
		projectInstructions: [],
	});
}
