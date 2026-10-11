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
	const guessedSources = input.sections?.map(section => ({
		...section,
		// Allocate rounding along the contiguous prompt so every token belongs to exactly one section.
		tokens: textTokens(input.systemPrompt.slice(0, section.end)) - textTokens(input.systemPrompt.slice(0, section.start)),
	}));
	const sourceTokens = (source: PromptSection["source"]) => guessedSources?.filter(section => section.source === source).reduce((sum, section) => sum + section.tokens, 0) ?? 0;
	const guessedMemoryFiles = guessedSources ? [] : input.projectInstructions.map((file) => ({ path: file.path, tokens: textTokens(file.content) }));
	const guessed = {
		messages: estimateTokens(input.messages),
		systemTools: toolTokens(input.builtinTools),
		mcpTools: toolTokens(input.mcpTools),
		skills: guessedSources ? sourceTokens("skills") : textTokens(input.skillCatalogue),
		memory: guessedSources ? sourceTokens("projectInstructions") : guessedMemoryFiles.reduce((acc, f) => acc + f.tokens, 0),
		projectMemory: guessedSources ? sourceTokens("projectMemory") : textTokens(input.projectMemory ?? ""),
		systemPrompt: 0,
	} satisfies Record<ContextSegmentKey, number>;
	/*
	 * The prompt minus the parts listed separately.
	 *
	 * They are embedded in the prompt string, so counting them as their own segments and leaving
	 * the prompt whole would report a total larger than anything that gets sent.
	 */
	guessed.systemPrompt = Math.max(0, textTokens(input.systemPrompt) - guessed.skills - guessed.memory - guessed.projectMemory);

	/*
	 * The provider's number is the total; every segment is still a characters-per-token guess.
	 *
	 * `usage.input` covers everything that went up — prompt, tool schemas and history together —
	 * so it anchors the total rather than being added beside the others. What it cannot say is
	 * which segment the guess was wrong about. Taking the conversation as "total minus guessed
	 * overhead" parked the whole error on it, on the theory that it is the biggest segment; at the
	 * start of a conversation it is the smallest. With a tokenizer denser than 3.5 characters per
	 * token (glm-5.3-flash), the overhead alone out-guessed a 14.4k request and "你好" showed no
	 * conversation at all. So the measured total is spread over the guesses in proportion.
	 */
	const total = measureTotal(input.messages);
	const keys = Object.keys(guessed) as ContextSegmentKey[];
	const guessedTotal = keys.reduce((sum, key) => sum + guessed[key], 0);
	const scaleTotal = scaler(total.measured && guessedTotal > 0 ? total.tokens / guessedTotal : 1);
	const sized = Object.fromEntries(keys.map(key => [key, scaleTotal(guessed[key])])) as Record<ContextSegmentKey, number>;
	// The per-file and per-section rows are parts of a segment, so they are scaled to sum to it.
	const within = (key: ContextSegmentKey) => scaler(guessed[key] > 0 ? sized[key] / guessed[key] : 0);
	const sourceScalers = new Map<PromptSection["source"], (tokens: number) => number>();
	const segmentOf = (source: PromptSection["source"]): ContextSegmentKey => source === "skills" ? "skills" : source === "projectInstructions" ? "memory" : source === "projectMemory" ? "projectMemory" : "systemPrompt";
	const sources = guessedSources?.map(section => {
		let scale = sourceScalers.get(section.source);
		if (!scale) sourceScalers.set(section.source, scale = within(segmentOf(section.source)));
		return { ...section, tokens: scale(section.tokens) };
	});
	const fileRows = (source: PromptSection["source"]) => sources?.filter(section => section.source === source && section.path).map(section => ({ path: section.path!, tokens: section.tokens }));
	const scaleMemory = within("memory");
	const memoryFiles: MemoryFileItem[] = fileRows("projectInstructions") ?? guessedMemoryFiles.map(file => ({ ...file, tokens: scaleMemory(file.tokens) }));
	const scaleProjectMemory = within("projectMemory");

	const segments = keys.map(key => ({ key, tokens: sized[key] }))
		.filter((segment) => segment.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);

	return {
		sources,
		projectMemory: sources ? sources.filter(section => section.source === "projectMemory").map(section => input.systemPrompt.slice(section.start, section.end)).join("") || undefined : input.projectMemory,
		projectMemoryFiles: fileRows("projectMemory") ?? input.projectMemoryFiles?.map((file) => ({ path: file.path, tokens: scaleProjectMemory(textTokens(file.content)) })),
		limit: input.model.contextWindow,
		segments,
		used: keys.reduce((sum, key) => sum + sized[key], 0),
		measured: total.measured,
		memoryFiles: memoryFiles.length > 0 ? memoryFiles : undefined,
	};
}

/** Rounds the running sum rather than each part, so scaled parts still add up to the scaled whole. */
function scaler(factor: number): (tokens: number) => number {
	let seen = 0;
	return (tokens) => {
		const before = Math.round(seen * factor);
		seen += tokens;
		return Math.round(seen * factor) - before;
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
