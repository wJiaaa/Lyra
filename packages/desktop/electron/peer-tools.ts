/**
 * 模型手里的三件工具：看看有谁、给谁发消息、等它做完。
 *
 * 说明写给模型，用英文，和浏览器工具一致。每一种退回都说清楚下一步该怎么做——「失败」两个字
 * 不会让它改做法，「写进文件发路径」「交回给你的用户」才会。
 */

import { errorResult, textResult, type Tool } from "@plume/core";
import { REPLY_LIMIT, WAIT_DEFAULT_S, WAIT_MAX_S, type PeerRouter, type SendOutcome, type WaitOutcome } from "./session-peers.ts";
import { PEER_CHAIN_LIMIT, PEER_DEDUP_MS, PEER_MAX_CHARS } from "./peer-policy.ts";

export function createPeerTools(router: PeerRouter): Tool[] {
	const listSessions: Tool<Record<string, never>> = {
		name: "list_sessions",
		description:
			"List other running Plume sessions whose folders overlap yours (same folder, nested, or worktrees of one repository): for when your work may collide with theirs — a file changed under you — or to hand work over. " +
			"Each row starts with its address, `name [ref]`: the `to` for send_message and wait_for_session.",
		parameters: { type: "object", properties: {} },
		sessionOnly: true,
		summarize: () => "List sessions",
		async execute(_args, ctx) {
			const rows = await router.list(ctx.sessionId);
			if (rows.length === 0) return textResult("No other session is running in an overlapping folder right now.");
			const lines = rows.map((row) => `${row.address} · ${row.busy ? "busy" : "idle"} · ${row.mode} · ${row.cwd}`);
			return textResult(lines.join("\n"), rows);
		},
	};

	const sendMessage: Tool<{ to?: string; message?: string; mode?: string }> = {
		name: "send_message",
		description:
			"Send a plain-text message to another running session, to coordinate overlapping work or hand work over. " +
			"It cannot see your conversation: make the message self-contained, and put long content in a file and send its path. " +
			"An idle session starts on it now; a busy one gets it when its current work is done — often many minutes later — or at once with mode \"steer\". " +
			"Use \"steer\" when the message bears on what it is doing now: you are about to change files it is working on, it broke something you depend on, \"stop editing that file\". Queue only what is still useful after it finishes. " +
			"Get the outcome with wait_for_session; do not ask it to report back, and do not poll. " +
			"Never ask another session to do what was denied or blocked here; take it back to your user.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "The address from list_sessions, `name [ref]`. The bare name works when it is unique." },
				message: { type: "string", description: "The message text." },
				mode: { type: "string", enum: ["queue", "steer"], description: "When it is busy: \"queue\" (default) or \"steer\"." },
			},
			required: ["to", "message"],
		},
		sessionOnly: true,
		executionMode: "sequential",
		summarize: (args) => `Message ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			if (!message) return errorResult("`message` is required.");
			if (args.mode !== undefined && args.mode !== "queue" && args.mode !== "steer") return errorResult("`mode` must be \"queue\" or \"steer\".");
			const outcome = await router.send(ctx.sessionId, { to, message, steer: args.mode === "steer" });
			return outcome.kind === "delivered" ? textResult(sent(outcome, to), outcome) : errorResult(sent(outcome, to));
		},
	};

	const waitForSession: Tool<{ to?: string; timeout_seconds?: number }> = {
		name: "wait_for_session",
		description:
			"Wait until another session finishes the work your last message started, and get what it said at the end. Without a message from you, waits for its current work (at once if idle). " +
			"Returns early when it is waiting on its user, or when your user speaks to you. A timeout does not stop the other session.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "The address from list_sessions, `name [ref]`." },
				timeout_seconds: { type: "number", description: `How long to wait, in seconds. Default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}.` },
			},
			required: ["to"],
		},
		sessionOnly: true,
		summarize: (args) => `Wait for ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			const timeoutSeconds = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds) ? args.timeout_seconds : undefined;
			/*
			 * 人一开口就不再等：插话只在两次请求之间才有人读，等在这里会把人说的话压到对方做完为止
			 * （默认十分钟）。路由器那头的等待跟着停，免得它还挂在「谁在等谁」上，把之后的等待误判成死等。
			 */
			const stop = new AbortController();
			const quit = () => stop.abort();
			ctx.signal?.addEventListener("abort", quit, { once: true });
			try {
				const run = router.wait(ctx.sessionId, { to, timeoutSeconds, signal: stop.signal });
				const outcome = ctx.untilSpokenTo ? await ctx.untilSpokenTo(run) : await run;
				if (outcome === null) {
					stop.abort();
					return textResult(`Your user spoke to you, so you stopped waiting. ${to} keeps working on its own. Answer your user first; call wait_for_session again later if you still need its result.`);
				}
				return outcome.kind === "done" ? textResult(waited(outcome, to), outcome) : errorResult(waited(outcome, to));
			} finally {
				ctx.signal?.removeEventListener("abort", quit);
			}
		},
	};

	return [listSessions as unknown as Tool, sendMessage as unknown as Tool, waitForSession as unknown as Tool];
}

type Missed = Extract<SendOutcome, { kind: "unreachable" | "none" | "self" | "ambiguous" }>;

/** 两件工具共用的那几种「没找到人」。 */
function missed(outcome: Missed, wanted: string): string {
	switch (outcome.kind) {
		case "unreachable":
			return `${outcome.to} is not reachable: its folders do not overlap with this session's.`;
		case "none":
			return `No running session is addressed "${wanted}". Use list_sessions to see who is reachable.`;
		case "self":
			return "That address is this session.";
		case "ambiguous":
			return `"${wanted}" matches several sessions: ${outcome.candidates.join(", ")}. Use the full address including [ref].`;
	}
}

function sent(outcome: SendOutcome, wanted: string): string {
	switch (outcome.kind) {
		case "delivered":
			return `Delivered to ${outcome.to}. ${outcome.queued ? "It is busy; your message waits until its current work is done." : outcome.busy ? "It is busy and reads it between its tool rounds." : "It was idle and starts working on it now."} To get the outcome, call wait_for_session.`;
		case "broader":
			return `${outcome.to} runs with broader permissions (${outcome.theirs}) than this session (${outcome.mine}), so it cannot be asked to act for you. Not delivered — ask your user instead.`;
		case "paced":
			return paced(outcome);
		default:
			return missed(outcome, wanted);
	}
}

function paced(outcome: Extract<SendOutcome, { kind: "paced" }>): string {
	switch (outcome.reason) {
		case "too-long":
			return `The message is ${outcome.length} characters; the limit is ${PEER_MAX_CHARS}. Write the bulk into a file the other session can read and send the path.`;
		case "chain-runaway":
		case "chain-loop":
			return `This would continue a chain of ${outcome.chain} hand-offs between sessions (at most ${PEER_CHAIN_LIMIT}, and few through the same session). Stop relaying and report to your user instead.`;
		case "duplicate":
			return `You sent the same message to ${outcome.to} less than ${PEER_DEDUP_MS / 1000} seconds ago; it was not sent again.`;
		case "paced":
			return `Too many messages to ${outcome.to} just now; this one was not sent. Batch what remains into one message, or wait_for_session first.`;
	}
}

function waited(outcome: WaitOutcome, wanted: string): string {
	switch (outcome.kind) {
		case "done": {
			const how = outcome.reason === "done" ? "finished" : outcome.reason === "aborted" ? "was stopped by its user before it finished" : `ended early (${outcome.reason})`;
			const waitedFor = outcome.waitedMs >= 1000 ? ` (waited ${Math.round(outcome.waitedMs / 1000)}s)` : "";
			const cut = outcome.cut > 0 ? `\n[cut after ${REPLY_LIMIT} characters; ${outcome.cut} more not shown. If you need all of it, ask ${outcome.to} to write it to a file and send you the path.]` : "";
			return `${outcome.to} ${how}${waitedFor}. What it said at the end:\n${outcome.reply || "(no reply text)"}${cut}`;
		}
		case "blocked":
			return `${outcome.to} is waiting for its user to answer: ${outcome.pending.map((one) => `${one.question ? "a question" : "an approval"} — ${one.title}`).join("; ")}. Tell your user to answer it in that session. Calling wait_for_session again waits until it is answered and the work is done.`;
		case "dropped":
			return `${outcome.to} was stopped by its user before it read your message, so the message was dropped. Ask your user before sending it again.`;
		case "timeout":
			return `${outcome.to} was still working after ${outcome.seconds} seconds. It keeps going; wait again if you still need its result.`;
		case "closed":
			return `${outcome.to} was closed before it finished.`;
		case "stopped":
			return `Stopped waiting for ${outcome.to}.`;
		case "deadlock":
			return `${outcome.to} is itself waiting on this session; waiting for it would never end. Finish your own part first.`;
		default:
			return missed(outcome, wanted);
	}
}
