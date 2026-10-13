/**
 * A ```ui block in a reply, drawn as the interface it describes.
 *
 * The language — markup, expressions, the catalog of components — is `@plume/core/ui-language`,
 * shared with the prompt that teaches it and the check that reports on it. This is the drawing, and
 * the three things the drawing owns:
 *
 * - **It grows as it is written.** Each finished tag appears as it arrives (`parseBlock` holds back
 *   the one being written, and dots hold its place meanwhile — see `arrive.ts`); the block is inert
 *   until its closing fence is in, so nothing is pressed while its options are still arriving under
 *   the cursor.
 * - **It remembers.** What the reader set, and the tab they had open, is kept per block across
 *   reloads (`interface-state.ts`).
 * - **It answers.** A `send` button says its words in the reader's name, and the model gets the
 *   values set in the block along with them; the reader's bubble shows only the words. Said, the
 *   button reads as sent until something it would say changes — see `isSent`.
 *
 * If drawing throws anyway, the block falls back to its source as code — the reply stays readable.
 */

import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { initialState, parseBlock } from "@plume/core/ui-language";
import { useScopedSessionId } from "../../../app/session-scope.tsx";
import { sayFor } from "../../../store/say.ts";
import { useArrivals } from "./arrive.ts";
import { recall, remember, stateKey, type BlockState } from "./interface-state.ts";
import { renderNodes, type Scope } from "./render.tsx";

function same(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((name) => Object.hasOwn(b, name) && JSON.stringify(a[name]) === JSON.stringify(b[name]));
}

/** What a `send` gives the model: the words, and what the reader set, in a form it can read back. */
function spoken(words: string, values: Record<string, unknown>): string {
	return Object.keys(values).length ? `${words}\n\n<interface-values>${JSON.stringify(values)}</interface-values>` : words;
}

class Boundary extends Component<{ source: string; fallback: ReactNode; children: ReactNode }, { failed: string | null }> {
	override state = { failed: null as string | null };

	static getDerivedStateFromError(): Partial<{ failed: string | null }> {
		return { failed: "" };
	}

	// The next piece of a block being written may well draw: try again whenever the text changes.
	static getDerivedStateFromProps(props: { source: string }, state: { failed: string | null }) {
		return state.failed === "" ? { failed: props.source } : state.failed !== null && state.failed !== props.source ? { failed: null } : null;
	}

	override render() {
		return this.state.failed === null ? this.props.children : this.props.fallback;
	}
}

/**
 * While the block is written, its height follows its content by a transition rather than in steps.
 *
 * A finished tag arrives whole — three figures at once are 240px — and the transcript following its
 * bottom is pushed down by that in one frame and then glides back (`useFollowBottom`): measured, the
 * running line under the reply dropped 238px and slid up again for every element that appeared. Grown
 * over a transition instead, each frame adds a little and the follow keeps up as it does with text.
 * Once written the height is the content's own again, so a tab switched by the reader is not delayed.
 */
function Growing({ active, children }: { active: boolean; children: ReactNode }) {
	const inner = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | null>(null);
	useLayoutEffect(() => {
		const element = inner.current;
		if (!active || !element) return setHeight(null);
		const measure = () => setHeight(element.getBoundingClientRect().height);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [active]);
	return (
		<div style={active && height !== null ? { height } : undefined} className={`my-2.5 ${active ? "overflow-hidden transition-[height] duration-[var(--ly-t-base)] ease-[var(--ly-e-out)]" : ""}`}>
			<div ref={inner}>{children}</div>
		</div>
	);
}

export function InterfaceBlock({ source, writing, fallback }: { source: string; writing: boolean; fallback: ReactNode }) {
	const sessionId = useScopedSessionId();
	const parsed = useMemo(() => parseBlock(source), [source]);
	const initial = useMemo(() => initialState(parsed.nodes), [parsed]);
	const key = stateKey(sessionId, source);
	const drawing = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const pending = writing ? parsed.pending : undefined;
	const shown = parsed.nodes.length > 0 || pending !== undefined;
	// Not before it is shown: a block starts out empty and draws nothing, so there is nothing to watch yet.
	useArrivals(drawing, layer, writing && shown);
	// Only a finished block has a key worth remembering under: while it is written the text changes every frame.
	const fresh = (): BlockState & { key: string } => ({ key, ...(writing ? { values: {} } : recall(key)) });
	const [own, setOwn] = useState(fresh);
	if (own.key !== key) setOwn(fresh());
	useEffect(() => {
		if (!writing && (Object.keys(own.values).length || own.sent || own.tabs)) remember(own.key, { values: own.values, ...(own.sent ? { sent: own.sent } : {}), ...(own.tabs ? { tabs: own.tabs } : {}) });
	}, [own, writing]);

	const values = { ...initial, ...own.values };
	const scope: Scope = {
		values,
		depth: 0,
		pending,
		set: (next) => setOwn((was) => ({ ...was, values: { ...was.values, ...next } })),
		send: (words) => {
			if (sessionId) sayFor(sessionId, words, spoken(words, values));
			else return;
			setOwn((was) => ({ ...was, sent: { words, values } }));
		},
		/*
		 * Said already, as it would be said now. Without this the button looked the same after it was
		 * pressed: nothing on the block told which choice had gone, and going back to it read as an
		 * invitation to send it again. The words and the values both, since a value the words do not
		 * mention still goes to the model.
		 */
		isSent: (words) => own.sent?.words === words && same(own.sent.values, values),
		tabs: {
			get: (id) => own.tabs?.[id],
			set: (id, title) => setOwn((was) => ({ ...was, tabs: { ...was.tabs, [id]: title } })),
		},
	};
	if (!shown) return null;
	return (
		<Boundary source={source} fallback={fallback}>
			<Growing active={writing}>
				<div className="relative">
					<div ref={drawing} className="ly-ui" data-ly-interface={writing ? "writing" : "ready"} aria-busy={writing || undefined} inert={writing || undefined}>
						{renderNodes(parsed.nodes, scope)}
					</div>
					<div ref={layer} aria-hidden className="pointer-events-none absolute inset-0" />
				</div>
			</Growing>
		</Boundary>
	);
}
