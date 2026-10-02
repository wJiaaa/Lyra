/**
 * Where the context window actually goes.
 *
 * A single "12.5k / 128k" is enough to notice you are filling up and useless for doing anything
 * about it — the answer to "why is this so expensive?" is nearly always one segment, and which
 * one decides what you would do: prune the conversation, drop an MCP server, or trim a CLAUDE.md
 * that grew without anyone reading it again. So the number is broken down by what put it there.
 *
 * Measured on the strings that are actually sent. Tool schemas go up as JSON on every request,
 * so they are measured as JSON; the prompt's own sections are measured as text. Nothing is
 * counted twice: the skill catalogue and the project instructions are carved out of the system
 * prompt rather than added to it, which is why the segments sum to the total.
 */

import type { Message, ModelConfig, ToolSpec } from "../types.ts";
import { estimateTokens, measureTotal, textTokens, toolTokens } from "../tokens.ts";
import type { PromptSection } from "../prompt/context.ts";

export type ContextSegmentKey = "messages" | "systemTools" | "mcpTools" | "skills" | "systemPrompt" | "memory" | "projectMemory";

export interface ContextSegment {
	key: ContextSegmentKey;
	tokens: number;
}

export interface MemoryFileItem {
	path: string;
	tokens: number;
}

export interface ContextBreakdown {
	/** The model's window, so the caller does not have to look it up again to compute a share. */
	limit: number;
	/** Everything that will be sent, in descending order of size. */
	segments: ContextSegment[];
	used: number;
	/** True once the numbers come from the provider rather than from a characters-per-token guess. */
	measured: boolean;
	/** Individual memory / instruction files making up the 'memory' segment. */
	memoryFiles?: MemoryFileItem[];
	projectMemory?: string;
	projectMemoryFiles?: MemoryFileItem[];
	/** Provenance and estimated size of the sections in the actual assembled prompt. */
	sources?: (PromptSection & { tokens: number })[];
}


export function buildContextBreakdown(input: {
	model: ModelConfig;
	messages: Message[];
	systemPrompt: string;
	builtinTools: ToolSpec[];
	mcpTools: ToolSpec[];
	skillCatalogue: string;
	/** As `buildSystemPrompt` receives them, so the same text is measured that gets embedded. */
	projectInstructions: { path: string; content: string }[];
	projectMemory?: string;
	projectMemoryFiles?: { path: string; content: string }[];
	sections?: PromptSection[];
}): ContextBreakdown {
	const sources = input.sections?.map(section => ({
		...section,
		// Allocate rounding along the contiguous prompt so every token belongs to exactly one section.
		tokens: textTokens(input.systemPrompt.slice(0, section.end)) - textTokens(input.systemPrompt.slice(0, section.start)),
	}));
	const sourceTokens = (source: PromptSection["source"]) => sources?.filter(section => section.source === source).reduce((sum, section) => sum + section.tokens, 0) ?? 0;
	const projectMemory = sources ? sourceTokens("projectMemory") : textTokens(input.projectMemory ?? "");
	const skills = sources ? sourceTokens("skills") : textTokens(input.skillCatalogue);
	const memoryFiles: MemoryFileItem[] = sources ? sources.filter(section => section.source === "projectInstructions" && section.path).map(section => ({ path: section.path!, tokens: section.tokens })) : input.projectInstructions.map((file) => ({
		path: file.path,
		tokens: textTokens(file.content),
	}));
	const memory = sources ? sourceTokens("projectInstructions") : memoryFiles.reduce((acc, f) => acc + f.tokens, 0);
	/*
	 * The prompt minus the parts listed separately.
	 *
	 * They are embedded in the prompt string, so counting them as their own segments and leaving
	 * the prompt whole would report a total larger than anything that gets sent.
	 */
	const systemPrompt = Math.max(0, textTokens(input.systemPrompt) - skills - memory - projectMemory);

	const systemTools = toolTokens(input.builtinTools);
	const mcpTools = toolTokens(input.mcpTools);
	const overhead = systemTools + mcpTools + skills + systemPrompt + memory + projectMemory;

	/*
	 * The provider's number is the total, not the conversation's share.
	 *
	 * `usage.input` covers everything that went up — prompt, tool schemas and history together.
	 * Treating it as the message segment and then adding the others alongside would report a
	 * context far larger than anything actually sent. So the measured figure anchors the total
	 * and the conversation is what is left after the fixed overhead, which also parks the
	 * estimator's error on the one segment that is too big to be sensitive to it.
	 */
	const total = measureTotal(input.messages);
	const messages = total.measured ? Math.max(0, total.tokens - overhead) : estimateTokens(input.messages);

	const segments = ([
		{ key: "messages", tokens: messages },
		{ key: "systemTools", tokens: systemTools },
		{ key: "mcpTools", tokens: mcpTools },
		{ key: "skills", tokens: skills },
		{ key: "systemPrompt", tokens: systemPrompt },
		{ key: "memory", tokens: memory },
		{ key: "projectMemory", tokens: projectMemory },
	] satisfies ContextSegment[])
		.filter((segment) => segment.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);

	return {
		sources,
		projectMemory: sources ? sources.filter(section => section.source === "projectMemory").map(section => input.systemPrompt.slice(section.start, section.end)).join("") || undefined : input.projectMemory,
		projectMemoryFiles: sources ? sources.filter(section => section.source === "projectMemory" && section.path).map(section => ({ path: section.path!, tokens: section.tokens })) : input.projectMemoryFiles?.map((file) => ({ path: file.path, tokens: textTokens(file.content) })),
		limit: input.model.contextWindow,
		segments,
		used: messages + overhead,
		measured: total.measured,
		memoryFiles: memoryFiles.length > 0 ? memoryFiles : undefined,
	};
}

/**
 * What the whole next request will carry.
 *
 * Taken from the last settled reply when there is one: what that turn sent, read from cache and
 * wrote is exactly the context the next question inherits, and it comes from the provider rather
 * than from a guess. Anything said since has never been in a request, so only that tail is
 * estimated. Before the first reply there is nothing to measure and the estimate stands alone.
 */
