/**
 * A `preview` call in the conversation, from its first written character to the finished page.
 *
 * While the model writes, the draft (`PreviewDraft`); once the page is checked and served, the page
 * itself (`PreviewCard`). The handover is the part that shows: the page loads underneath the draft,
 * starts at the height the draft reached, fades in over it, and only then does the draft go. Swapping
 * one for the other outright left a blank card for as long as the page took to load.
 *
 * Only a call seen being written gets a draft. Opening a conversation shows its finished pages as
 * they are; building each one again out of its arguments would be a second frame and a flash for
 * every page in the history.
 *
 * The finished page is drawn by the caller (`page`), not imported here: `PreviewCard` reaches the
 * side panel through `dock/index.ts`, which leads back to this domain's index, and importing it here
 * as well closed a new cycle (`pnpm arch`). Same split as `BubbleText`.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Message } from "@plume/core";
import { useScopedFromMessages } from "../../app/session-scope.tsx";
import { PreviewDraft } from "./PreviewDraft.tsx";
import { draftArguments, draftDocument } from "./preview-draft.ts";

/**
 * The call's arguments text as it stands in the transcript now.
 *
 * Read here rather than taken from the row: the row is redrawn when the transcript's shape changes
 * (`sameRun`), not on every streamed piece of one call's arguments, so a draft fed from it froze at
 * whatever had been written when it first appeared. A string, so only a change in it redraws. Only
 * the last few messages: the call being written is in the reply being written.
 */
function writtenSoFar(messages: Message[], id: string): string | null {
	for (let at = messages.length - 1; at >= Math.max(0, messages.length - 4); at--) {
		const message = messages[at]!;
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall" && block.id === id) return block.argumentsText ?? null;
	}
	return null;
}

/** How long the page is left fading in over the draft before the draft goes — the page's own fade. */
const HANDOVER_MS = 260;

/** What the finished page needs from the call: where to start, and a word once it is on screen. */
export interface PreviewHandover {
	startHeight?: number;
	onShown?: () => void;
}

export function PreviewCall({ block, served, page: drawPage, live, written, fallback }: {
	block: { id: string; arguments: Record<string, unknown>; argumentsText?: string };
	/** The page has been checked and served: there is a finished page to draw. */
	served: boolean;
	/** Draws the served page: a `PreviewCard`. */
	page: (handover: PreviewHandover) => ReactNode;
	/** Still being written or checked: the only time a draft means anything. */
	live: boolean;
	/** The arguments are all in and the call is running: what is left is the app checking the page. */
	written: boolean;
	/**
	 * What the call is when it is not a page: a tool row, as any other call. Given the page's title
	 * while it is written — the row's own summary only comes once the arguments are all in, and until
	 * then it would say `preview`.
	 */
	fallback: (title?: string) => ReactNode;
}) {
	const [streamed] = useState(() => !served && live);
	const raw = useScopedFromMessages((messages) => (streamed ? writtenSoFar(messages, block.id) : null)) ?? block.argumentsText;
	const [landed, setLanded] = useState(false);
	const [covered, setCovered] = useState(true);
	const [height, setHeight] = useState<number>();
	useEffect(() => {
		if (!landed) return;
		const timer = setTimeout(() => setCovered(false), HANDOVER_MS);
		return () => clearTimeout(timer);
	}, [landed]);

	if (!streamed) return <>{served ? drawPage({}) : fallback()}</>;
	const args = draftArguments(block.arguments, raw);
	const row = fallback(typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined);
	/*
	 * A check is drawn while it is written — that is most of the wait, and the reader would otherwise
	 * watch nothing for minutes — and goes once it is written: it is not published. A failed page goes
	 * too: it is not a page for the reader, whatever was drawn while it was written.
	 */
	const page = covered && (live || served) && (args.check !== true || !written) ? draftDocument(args) : null;
	/*
	 * Fixed slots, so the page is the same element before and after the draft goes: moved out of the
	 * overlay rather than mounted again, which would load it a second time — the flash this avoids.
	 */
	return (
		<div className="relative">
			{page && <PreviewDraft document={page} placeholder={row} complete={written} onHeight={setHeight} />}
			{served && (
				<div className={page ? "pointer-events-none absolute inset-x-0 top-0" : undefined}>
					{drawPage({ startHeight: height, onShown: () => setLanded(true) })}
				</div>
			)}
			{!page && !served && row}
		</div>
	);
}
