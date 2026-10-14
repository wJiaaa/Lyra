/**
 * 作用在「对话本身」上的两件工具：建议另开一个会话、做完后归档自己。
 *
 * `spawn_session` 只在对话里放一张建议卡片、立刻返回，人点了「开始」才建会话（卡片本身就是同意，
 * 所以不审批）。`archive_session` 要等提它的那一轮结束才归档。两件都只给桌面端的主会话：经
 * `extraTools` 注入，命令行没有；`sessionOnly` 让子代理和侧边聊天拿不到——子代理不是一个对话，
 * 它的 `ctx.sessionId` 是 `<父id>:sub:<id>`，替它画的卡片没处画，替它归档的是派它来的人的对话。
 * 说明写给模型，用英文，和 `peer-tools.ts` 一致。设计与取舍见 ADR-0049。
 */

import { errorResult, type AgentEvent, type Tool, type ToolResult } from "@plume/core";
import { ARCHIVE_SESSION_TOOL, SPAWN_SESSION_TOOL, type SessionSuggestionDetails } from "../shared/session-suggestion.ts";

/** Counted in code points, the way a person counts characters in a card title. */
const TITLE_MAX = 60;
const SUMMARY_MAX = 400;
/** A whole brief fits in this; anything longer is a transcript pasted into a prompt. */
const PROMPT_MAX = 20_000;
const REASON_MAX = 200;

interface SpawnArgs {
	title?: unknown;
	summary?: unknown;
	prompt?: unknown;
}

/** The trimmed text, or why it cannot be used — said so the model can send it again, fixed. */
function field(value: unknown, name: string, max: number): string | { error: string } {
	if (typeof value !== "string" || !value.trim()) return { error: `${name} is required and must be non-empty text.` };
	const text = value.trim();
	const length = [...text].length;
	if (length > max) return { error: `${name} is ${length} characters; keep it to ${max}.` };
	return text;
}

function spawnSession(args: SpawnArgs): ToolResult {
	const title = field(args.title, "title", TITLE_MAX);
	if (typeof title !== "string") return errorResult(title.error);
	const summary = field(args.summary, "summary", SUMMARY_MAX);
	if (typeof summary !== "string") return errorResult(summary.error);
	const prompt = field(args.prompt, "prompt", PROMPT_MAX);
	if (typeof prompt !== "string") return errorResult(prompt.error);
	const details: SessionSuggestionDetails = { kind: "session_suggestion", title, summary, prompt };
	return {
		content: [
			{
				type: "text",
				// The model has to hear that nothing ran: a card waiting on a click looks, from here, exactly like work in progress.
				text: `Suggested "${title}". Nothing has started: a card is waiting in the conversation, and the new session begins only if the person clicks Start. Carry on with the current task.`,
			},
		],
		details,
	};
}

/**
 * 两件工具。`archiveAfterTurn` 只是记下请求：真去归档的是主进程在这一轮的 `agent_end` 之后
 * （`archiveAfterTurn()`），那时已经没有可以被砍掉的东西了。
 */
export function createSessionOpsTools(host: { archiveAfterTurn(sessionId: string): void }): Tool[] {
	const spawn: Tool<SpawnArgs> = {
		name: SPAWN_SESSION_TOOL,
		description:
			"Suggest a new, separate conversation for something you noticed that is worth doing but would bloat the current change — dead code, stale docs, missing tests, a TODO you confirmed, a security problem spotted in passing. " +
			"Not for vague code smells, low-confidence guesses, small fixes you can make inline, or the current task itself. " +
			"Returns immediately and starts nothing: the person sees a card and decides. Keep working on the current task afterwards. " +
			"The prompt is the new conversation's first message and is all it will know: name the files and give enough context to act without this conversation.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", maxLength: TITLE_MAX, description: "The card's title: an imperative phrase starting with a verb, at most 60 characters." },
				summary: { type: "string", description: "One or two sentences for the card: first why you are suggesting it now, then what the new conversation will do." },
				prompt: { type: "string", description: "The new conversation's first message. Self-contained: file paths and context, no references to this conversation." },
			},
			required: ["title", "summary", "prompt"],
			additionalProperties: false,
		},
		sessionOnly: true,
		summarize: (args) => `Suggest session ${typeof args.title === "string" ? args.title.trim() : ""}`.trim(),
		execute: async (args) => spawnSession(args),
	};
	const archive: Tool<{ reason?: unknown }> = {
		name: ARCHIVE_SESSION_TOOL,
		description:
			"Archive this conversation once the current turn ends. Use it only when the person asked for this conversation to be archived, for example \"archive it when you're done\" — never on your own initiative. " +
			"Your turn ends as soon as this returns and nothing you write after it is read, so put your final reply in the same message, before the call. " +
			"The person can restore the conversation from Settings › Archived chats.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Optional: what was finished, in a few words." },
			},
			additionalProperties: false,
		},
		sessionOnly: true,
		executionMode: "sequential",
		summarize: () => "Archive session",
		async execute(args, ctx) {
			// `sessionOnly` already keeps it from sub-agents; refusing here as well keeps a tool list rebuilt
			// some other way from filing the parent away under a sub-agent's id.
			if (ctx.sessionId.includes(":sub:")) return errorResult("Only the conversation itself can archive itself; a sub-agent cannot.");
			let reason: string | undefined;
			if (args.reason !== undefined) {
				const checked = field(args.reason, "reason", REASON_MAX);
				if (typeof checked !== "string") return errorResult(checked.error);
				reason = checked;
			}
			host.archiveAfterTurn(ctx.sessionId);
			return {
				content: [
					{
						type: "text",
						text: "This conversation is archived as soon as this turn ends, which is now. The person can restore it from Settings › Archived chats.",
					},
				],
				details: { kind: "session_archive", ...(reason ? { reason } : {}) },
				// Ends the turn here: the archive waits for `agent_end`, and anything said after this would be filed away unread.
				terminate: true,
			};
		},
	};
	return [spawn, archive];
}

export interface ArchiveDeps {
	/** Write the archive mark. Through the observed store, so every window and paired phone hears of it. */
	archive(sessionId: string): Promise<void>;
	/** Whether the session is still doing something: the turn's wind-down, or work queued behind it. */
	busy(sessionId: string): boolean;
	/** Whether it is still archived when it is finally idle — it may have been brought back meanwhile. */
	archived(sessionId: string): Promise<boolean>;
	dispose(sessionId: string): Promise<void>;
	/** How long to wait between looks while the session is busy. */
	pollMs?: number;
}

export interface ArchiveAfterTurn {
	/** Called by the tool: archive this session when its current turn ends. */
	request(sessionId: string): void;
	/** Every event of every session passes here; only the end of a turn that asked matters. */
	observe(sessionId: string, event: AgentEvent): void;
}

/**
 * `archive_session` 的主进程那一半。
 *
 * 工具里不能当场归档：`sessions:setArchived` 先 `disposeSession`，处置会 abort 这一轮——砍掉的正是
 * 还在等这个工具返回的那一轮，最后一条结果落不进去，收尾报 aborted。所以工具只留下请求、用
 * `terminate` 结束这一轮；这里看着事件，在那一轮的 `agent_end` 之后归档，等会话闲下来再放掉它。
 */
export function archiveAfterTurn(deps: ArchiveDeps): ArchiveAfterTurn {
	const requested = new Set<string>();
	const pause = () => new Promise<void>((resolve) => setTimeout(resolve, deps.pollMs ?? 250));

	const settle = async (sessionId: string) => {
		await deps.archive(sessionId);
		/*
		 * Disposed only once it is idle, never at `agent_end` itself: `running` stays true through the
		 * turn's wind-down and through anything queued behind it, and disposing aborts whatever is in
		 * flight — the cut this whole detour exists to avoid.
		 */
		while (deps.busy(sessionId)) await pause();
		if (await deps.archived(sessionId)) await deps.dispose(sessionId);
	};

	return {
		request(sessionId) {
			requested.add(sessionId);
		},
		observe(sessionId, event) {
			// One request, one turn: whichever way that turn ends, the next one starts without it.
			if (event.type !== "agent_end" || !requested.delete(sessionId)) return;
			/*
			 * Only a turn that ended the way it was asked to. Stopped or failed, the conversation stays
			 * where the person can see what happened — a stop pressed after the call is the newer word,
			 * and an archive would carry the failure out of sight.
			 */
			if (event.reason !== "done") return;
			void settle(sessionId).catch((error: unknown) => console.error("[session-ops] archive after turn failed", error));
		},
	};
}
