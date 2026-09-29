/**
 * The conversation beside the conversation.
 *
 * A scratchpad that can see what the main session is doing but does not write into it. Anything
 * that needs doing gets dispatched to that session's queue instead, which is what `TaskStrip`
 * below the messages reports on.
 *
 * Only the arrangement lives here: a message is `sidechat/MessageRow`, the dispatched work is
 * `sidechat/TaskStrip`, and the field is `sidechat/SideComposer`.
 */

import { translate } from "../../i18n/translate.ts";
import { MessageCirclePlus, RotateCcw } from "lucide-react";
import type { Message, UserMessage } from "@plume/core";
import { useEffect, useState } from "react";
import { useSide, sideChatOf } from "../dock/index.ts";
import { useSideTarget } from "./target.ts";
import { BackToLatest, spokenText } from "../conversation/index.ts";
import { sideIdOfPanel } from "../../lib/panel-instance.ts";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useFollowBottom } from "../../ui/scroll/useFollowBottom.ts";
import { tailSignature } from "../../ui/scroll/signature.ts";
import { ThinkingLine } from "../conversation/index.ts";
import { moodFor, phraseFor } from "../../lib/thinking-words.ts";
import { lastIsSettled, MessageRow, rowKey } from "./MessageRow.tsx";
import { SideComposer } from "./SideComposer.tsx";
import { TaskStrip } from "./TaskStrip.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

export function SideChat() {
	const { sessionId, sideId } = useSideTarget();
	const messages = useSide((s) => sideChatOf(s, sessionId, sideId).messages);
	const running = useSide((s) => sideChatOf(s, sessionId, sideId).running);
	const loading = useSide((s) => sideChatOf(s, sessionId, sideId).loading);
	const error = useSide((s) => sideChatOf(s, sessionId, sideId).error);
	const ask = useSide((s) => s.ask);
	const abort = useSide((s) => s.abort);

	/*
	 * 这一屏的那份对话，由这个面板自己去拉。
	 *
	 * 从前只有 `ChatShell` 拉一次「当前会话」的，于是分屏里另一屏的侧边聊天要么是空的，要么画
	 * 的是别人的。面板知道自己属于谁，就该自己开口要；`attach` 是幂等的，重复叫不会多拉。
	 */
	useEffect(() => {
		void useSide.getState().attachChat(sessionId, sideId);
	}, [sessionId, sideId]);

	/*
	 * The same rule the main transcript follows, from the same place.
	 *
	 * This panel used to keep its own: a lone `pinned` ref, a 60px slack where the conversation had
	 * 80, no reaction to the panel being resized, and no way back down once you had scrolled up. The
	 * ref was the worst of it — it never reset, so scrolling up here and then switching the main
	 * conversation left the incoming session's side chat parked at an offset that belonged to the
	 * one before it.
	 */
	/** 正在答的那一条——它末尾那段工具调用亮着，别的都已经是记录了。 */
	const lastReply = messages.findLastIndex((message) => message.role === "assistant");
	const follow = useFollowBottom({
		// 每个侧边聊天各记各的滚动位置：切个标签回来，还停在刚才读到的地方。
		surfaceId: sessionId ? `${sessionId}:${sideId}` : null,
		namespace: "sidechat",
		live: running,
		count: messages.length,
		tail: tailSignature(messages, running ? "run" : ""),
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{!sessionId ? (
				// It reads the conversation it is attached to; without one there is nothing to be
				// beside.
				<PanelEmpty icon={MessageCirclePlus} title={translate("dock.sideChat")}>
					{translate("sideChat.needSession")}
				</PanelEmpty>
			) : loading && messages.length === 0 ? (
				<div role="status" className="flex flex-1 items-center justify-center text-label text-ink-faint">{translate("sideChat.loading")}</div>
			) : messages.length === 0 ? (
				<PanelEmpty icon={MessageCirclePlus} title={translate("dock.sideChat")}>
					{translate("sideChat.empty")}
				</PanelEmpty>
			) : (
				<div className="relative flex min-h-0 flex-1 flex-col">
				<Scroller
					className="flex-1"
					scrollRef={follow.scrollRef}
					contentClassName="ly-content-gutter"
					onScroll={follow.onScroll}
					onResize={follow.onResize}
					onUserScroll={follow.onUserScroll}
				>
					{/*
					 * Capped and centred, exactly as the main transcript is.
					 *
					 * At panel width this changes nothing. Full screen it is the difference between
					 * a conversation and a wall of text a metre wide — prose stops being readable
					 * somewhere around 90 characters, and the panel is over twice that when it
					 * takes the whole column.
					 */}
					{/* Bottom padding leaves 「回到最新」 somewhere to float that is not the newest reply. */}
					<div className="mx-auto flex w-full max-w-[var(--ly-content)] flex-col gap-2.5 pt-3 pb-[var(--ly-bottom-inset)]">
						{messages.map((message, index) => (
							<MessageRow key={rowKey(message, index)} message={message} index={index} live={running && index === lastReply} />
						))}
						{/*
						 * The same line the main transcript shows while it waits, minus the meter.
						 *
						 * Both conversations are waiting on a model and should say so the same way; a
						 * spinner and the words 「思考中…」 next to the main transcript's orb and phrase
						 * made the panel read as a different application. Elapsed time and tokens are
						 * the main session's to report — this one has nothing to count.
						 */}
						{running && lastIsSettled(messages) && <SideThinking messages={messages} />}
						{/* The end of it, so that having seen the newest reply is a fact rather than a
						    guess made from how far down you are. See `useFollowBottom`. */}
						<div ref={follow.tailRef} aria-hidden className="h-px w-full shrink-0" />
					</div>
				</Scroller>
				{/*
				 * The way back, which this panel never had.
				 *
				 * It streams like the main transcript does, so scrolling up to read something while a
				 * reply is arriving leaves you with no route back to it but dragging — and "back" keeps
				 * moving while the reply is still being written.
				 */}
				<BackToLatest show={follow.away} unread={follow.unread} onClick={follow.returnToBottom} />
				</div>
			)}

			<TaskStrip />
			{error && <p role="alert" className="ly-content-gutter py-2 text-label text-danger">{error}</p>}

			<SideComposer
				running={running}
				disabled={!sessionId || loading}
				onSend={(content, meta) => void ask(sessionId, sideId, content, meta)}
				onStop={() => void abort(sessionId, sideId)}
			/>
		</div>
	);
}

/**
 * The side chat's own "working" line.
 *
 * Its own component so the phrase can advance on a timer without re-rendering the whole panel on
 * every tick — the transcript above it can be long, and a list that repaints four times a second
 * while the model thinks is the kind of thing that makes a window feel heavy.
 *
 * The mood is read off what is actually on screen, the same way `RunningIndicator` reads it: a
 * `text` block still arriving means composing, anything else means thinking.
 */
function SideThinking({ messages }: { messages: Message[] }) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 2600);
		return () => clearInterval(id);
	}, []);

	const last = messages[messages.length - 1];
	const writing =
		last?.role === "assistant" && last.content.some((block) => block.type === "text" && block.text.length > 0);
	const mood = moodFor(undefined, undefined, false, writing);
	return <ThinkingLine mood={mood} phrase={phraseFor(mood, tick, 0)} />;
}

/**
 * Starting the side chat over, as a mark in the pane's header.
 *
 * It used to sit inside the composer, beside send. That is the wrong row: everything else along the
 * bottom of a field belongs to the message being written — what will answer it, what is attached to
 * it, send it — and this one throws the whole conversation away. It was also the only thing in the
 * app's three composer rows that appeared in just one of them, which is most of why that field did
 * not look like the other two.
 *
 * A panel's header is where what-you-do-to-what-it-is-showing lives, beside the pane's own buttons.
 * The file panel keeps wrap and format there for the same reason — see `panels/registry.ts`.
 *
 * In this file rather than beside it: it needs the side chat's store, which lives in the dock, and
 * this module already reaches for it. A file of its own would be a third edge across that boundary
 * for fifteen lines.
 *
 * Drawn only when there is something to discard. On an empty side chat, starting over is what is
 * already on screen.
 */
export function SideChatActions() {
	const { sessionId, sideId } = useSideTarget();
	const messages = useSide((s) => sideChatOf(s, sessionId, sideId).messages);
	const reset = useSide((s) => s.reset);
	if (messages.length === 0) return null;
	return (
		// Sized and coloured like the pane's own header buttons — see `FileActions`.
		<IconButton size="xs" label={translate("sideChat.new")} onClick={() => void reset(sessionId, sideId)} icon={<RotateCcw size={12} strokeWidth={2} />} />
	);
}

/**
 * 侧边聊天那个标签上写什么：它问的第一句话，还没开口的写「侧边聊天」。
 *
 * 一个会话旁边开了好几个时，一排「侧边聊天」分不出谁是谁。见 `PanelDefinition.tabTitle`；`scope`
 * 就是这一屏的会话 id。
 */
export function SideChatTitle({ scope, kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const sideId = sideIdOfPanel(kind) ?? "";
	const first = useSide((s) => sideChatOf(s, scope, sideId).messages.find((message): message is UserMessage => message.role === "user"));
	const title = first ? spokenText(first).split("\n")[0]?.trim() : "";
	return title ? <span className="max-w-40 truncate" data-ly-tip={title}>{title}</span> : <>{fallback}</>;
}

/** 后开的那一个关掉：停下、存档一起删——没有别的入口能再把它叫回来。 */
export function closeSideChat(scope: string, sideId: string): void {
	void useSide.getState().close(scope, sideId);
}
