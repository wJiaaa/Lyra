/**
 * Streaming one assistant reply: one request, its retries, and how it ends.
 *
 * Separate from the loop because it answers a different question. The loop decides whether there is
 * another round; this turns one request into one settled message and the events the window draws.
 * Why each exit is shaped the way it is: docs/architecture/agent-loop.md.
 */

import type { AgentEventSink } from "./events.ts";
import type { AgentRunConfig } from "./run-config.ts";
import { streamAssistant } from "../ai/index.ts";
import { comparePrefix, payloadSegments, type PrefixSegment } from "../ai/prefix-fingerprint.ts";
import { requestPrompt } from "../runtime/cache-diagnostics.ts";
import { contextMaxTokens } from "../runtime/context.ts";
import type { AssistantMessage, LlmContext } from "../types.ts";

/** One assistant turn. */
export interface TurnResult {
	message: AssistantMessage;
	/** The model was switched before this request said anything; redo it from the same point. */
	switched?: boolean;
	/**
	 * A reply the far end rejected (`rejectedContent`), not yet committed (no `message_end`).
	 *
	 * The caller either recovers and `discard`s it, or gives up and `commit`s it. Committing first
	 * puts a failed reply in the log that the loop's view does not have, and the compaction
	 * boundary — counted from the log's tail — lands one message off.
	 */
	held?: { commit(): Promise<void>; discard(): Promise<void> };
}

/**
 * Whether a reply failed because the far end would not accept the request as posted.
 *
 * Narrow on purpose: a 401, 404 or 429 does not improve with a smaller history. Reads the failure
 * classification, never the wording of `errorMessage` — that line is for people and changes.
 */
export function rejectedContent(assistant: AssistantMessage): boolean {
	if (assistant.stopReason !== "error" || assistant.errorRetryable) return false;
	return assistant.failure?.hint === "check-request";
}

export async function streamTurn(config: AgentRunConfig, context: LlmContext, emit: AgentEventSink): Promise<TurnResult> {
	config.onContext?.(context, config.model);
	// Recalculate after compaction, model switches and payload recovery, for injected streams too.
	config = { ...config, maxTokens: contextMaxTokens(config.model, context, config.maxTokens) };
	await emit({ type: "request", provider: config.provider.id, model: config.model.modelId, thinking: config.thinking, messageCount: context.messages.length });

	/*
	 * A model switch has its own controller: it means "redo with someone else", not "stop", so it
	 * must not be confused with `config.signal`. Only a request that has not said anything yet
	 * (connecting, retrying) is let go — that is exactly when a person switches away from a broken
	 * upstream. See ADR-0025.
	 */
	const switchAbort = new AbortController();
	let said = false;
	const unsubscribe = config.liveModel?.onChange(() => {
		const wanted = config.liveModel?.current();
		if (!said && wanted && wanted.model.id !== config.model.id) switchAbort.abort();
	});
	const switched = () => switchAbort.signal.aborted && !config.signal?.aborted;
	const signal = AbortSignal.any([...(config.signal ? [config.signal] : []), switchAbort.signal]);

	if (config.streamFn) {
		try {
			// The stand-in gets the same switch-aware signal, so switching is testable through it.
			const { provider, model, thinking, maxTokens, temperature, cacheKey } = config;
			const message = await config.streamFn(context, { provider, model, thinking, maxTokens, temperature, cacheKey, signal });
			if (switched()) return { message, switched: true };
			if (rejectedContent(message)) {
				const commit = async () => {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
				};
				return { message, held: { commit, discard: async () => {} } };
			}
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			return { message };
		} finally {
			unsubscribe?.();
		}
	}

	/*
	 * Retries of *this request*. The two nested retry layers (`fetchWithRetry`, `retryStream`) each
	 * number from 1, and passing theirs through made the line on screen count 1, 2, 1, 1, 2.
	 */
	let retries = 0;

	/*
	 * Where the prefix first differs from the previous request, stamped on the reply as evidence for
	 * cache misses (`ai/prefix-fingerprint.ts`). The baseline only advances on requests the cache
	 * diagnostics also count (`requestPrompt`), so both compare the same pair.
	 */
	let sent: PrefixSegment[] | undefined;
	let prefix: AssistantMessage["prefix"] | null = null;
	const stamp = (message: AssistantMessage): AssistantMessage => {
		if (prefix === null && sent && config.state) {
			const previous = config.state.get(PREFIX_KEY) as PrefixSegment[] | undefined;
			prefix = previous ? comparePrefix(previous, sent) : undefined;
			if (requestPrompt(message) > 0) config.state.set(PREFIX_KEY, sent);
		}
		if (prefix) message.prefix = prefix;
		return message;
	};
	const stream = stamped(streamAssistant(config.provider, config.model, context, {
		onPayload: config.state ? (body) => { sent = payloadSegments(body); } : undefined,
		signal,
		thinking: config.thinking,
		maxTokens: config.maxTokens,
		temperature: config.temperature,
		retryAttempts: config.retryAttempts,
		retryPolicy: config.retryPolicy,
		cacheKey: config.cacheKey,
		// Said out loud: seconds of silence while retrying are indistinguishable from a hang.
		onRetry: ({ delayMs, reason, failure }) => {
			retries += 1;
			void emit({ type: "retry", attempt: retries, delayMs, reason, failure });
		},
	}), stamp);

	let started = false;

	/*
	 * How the interruption ended. Only a clean first-try success has nothing to say — a failure
	 * that was never retried (bad key, wrong model name) must still be reported, or the window is
	 * left silent with no record of what happened.
	 */
	const settle = async (message: AssistantMessage) => {
		const failed = message.stopReason === "error";
		if (retries === 0 && !failed) return;
		await emit({
			type: "retry_settled",
			outcome: failed ? "gave_up" : "recovered",
			attempts: retries,
			failure: message.failure,
		});
	};

	/*
	 * Let go of the request for a model switch. Nothing reaches the transcript if the stream never
	 * started — an empty "stopped" bubble would read as the person pressing stop. The reconnect
	 * line is closed honestly: not recovered, switched.
	 */
	const letGo = async (message: AssistantMessage): Promise<TurnResult> => {
		if (started) await emit({ type: "message_end", message });
		if (retries > 0) {
			const to = config.liveModel?.current()?.model.name;
			await emit({ type: "retry_settled", outcome: "switched", attempts: retries, ...(to ? { switchedTo: to } : {}) });
		}
		return { message, switched: true };
	};

	try {
	while (true) {
		const next = await stream.next();
		if (next.done) {
			if (switched()) return await letGo(next.value);
			await settle(next.value);
			return { message: next.value };
		}
		const event = next.value;

		switch (event.type) {
			case "start":
				started = true;
				await emit({ type: "message_start", message: event.partial });
				break;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
			case "toolcall_end":
				said = true;
				await emit({ type: "message_update", message: event.partial, delta: event });
				break;
			case "done":
			case "error": {
				const message = event.message;
				if (switched()) {
					const tail = await stream.next();
					return await letGo(tail.done ? tail.value : message);
				}
				if (rejectedContent(message)) {
					const tail = await stream.next();
					const settled = tail.done ? tail.value : message;
					return {
						message: settled,
						held: {
							commit: async () => {
								if (!started) await emit({ type: "message_start", message: settled });
								await emit({ type: "message_end", message: settled });
								await settle(settled);
							},
							// The resend that follows is the outcome; a never-retried rejection reports nothing.
							discard: async () => {
								if (started) await emit({ type: "message_discarded", message: settled });
								if (retries > 0) await settle(settled);
							},
						},
					};
				}
				if (!started) await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				// Drain the generator so its `return` value is the authoritative final message.
				const tail = await stream.next();
				const settled = tail.done ? tail.value : message;
				await settle(settled);
				return { message: settled };
			}
			default:
				break;
		}
	}
	} finally {
		unsubscribe?.();
	}
}

/** The previous request's segments in session state; see `stamp` in `streamTurn`. */
const PREFIX_KEY = "requestPrefix";

/** Run the closing messages (in `done`/`error` events and the return value) through `stamp`. */
async function* stamped(
	stream: ReturnType<typeof streamAssistant>,
	stamp: (message: AssistantMessage) => AssistantMessage,
): ReturnType<typeof streamAssistant> {
	while (true) {
		const next = await stream.next();
		if (next.done) return stamp(next.value);
		if (next.value.type === "done" || next.value.type === "error") stamp(next.value.message);
		yield next.value;
	}
}
