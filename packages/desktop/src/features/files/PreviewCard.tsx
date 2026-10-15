import { translate } from "../../i18n/translate.ts";
import { AppWindow, Check, ChevronRight, ChevronsDown, Copy, ExternalLink, Maximize2, Minimize2, RotateCw, SlidersHorizontal } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { useSide } from "../dock/index.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { onAppearanceApplied } from "../settings/index.ts";
import { HEIGHT_MESSAGE, PREVIEW_MAX_HEIGHT, THEME_MESSAGE, WIDTH_KEY, previewFragment, readOpenRequest, readSendRequest, readStateRequest, type PreviewTheme } from "../../../shared/preview.ts";
import { MAX_ADJUSTMENTS, followHeight } from "./preview-height.ts";
import { previewTheme } from "./preview-theme.ts";
import { sayFor } from "../../store/say.ts";
import { markPageStatePending, readPageState, savePageState } from "../../store/page-state.ts";
import { usePreviewCopy } from "./preview-copy.ts";
import { tweakMessage, usePreviewTweaks } from "./preview-tweaks.ts";
import { PreviewTweaks } from "./PreviewTweaks.tsx";

export interface PreviewInfo {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
	/** Written against the theme variables — see `PreviewRecord.themed` in core. */
	themed?: boolean;
}

/**
 * The card sizes itself to its page, between these.
 *
 * The floor keeps a page that reports nothing useful from collapsing to a sliver; the ceiling
 * keeps one preview from taking the whole transcript, which is what a full-screen layout would
 * do if asked politely.
 */
const MIN_HEIGHT = 160;
/** Below this, the page has not really told us anything — see where this is used. */
const MEANINGFUL_HEIGHT = 90;
/**
 * The floor for a themed page, which is written to be as tall as its content (`previewTool`), so
 * what it reports is its height. Held to 160 a row of three badges stood on 60px of empty
 * conversation, with no card edge to say the page had ended.
 */
const THEMED_MIN_HEIGHT = 40;
const MAX_HEIGHT = PREVIEW_MAX_HEIGHT;
/** Used while measuring, and if the page never reports anything. */
const DEFAULT_HEIGHT = 440;
/** If the reporter never runs — blocked, broken, or a page with no head — stop waiting. Counted from the page's load. */
const PROBE_TIMEOUT_MS = 1500;
/** How long to keep collecting measurements before committing to one. */
const PROBE_SETTLE_MS = 400;
/** How long a link request waits for the click that sent it to be known here — see the link handler. */
const LINK_RECHECK_MS = 200;
/** One press, one message: a handler that asks twice for one press, or a double-click, says it once. */
const SEND_GAP_MS = 1500;

function previewUrl(preview: PreviewInfo): string {
	return `ly-preview://${preview.sessionId}/${preview.id}/${preview.entry}`;
}

/**
 * A page the agent made, running inside the conversation.
 *
 * The point is that a demo is not a description of a demo: a snake game you can play settles
 * in one second what a fenced code block takes a paragraph to explain, and a layout put up for
 * approval is answered by looking at it. So it renders here, in place, already interactive.
 *
 * The title stays as a conversation flow row so folding and reopening use the same control.
 * It adds no card chrome around themed pages; page actions stay over the page itself.
 *
 * Inside a sandboxed frame with `allow-scripts` and nothing else — no same-origin, so it cannot
 * reach this window; no top-navigation, so it cannot replace the app with something else. It is
 * served from its own `ly-preview://` origin rather than `file://`, which is what keeps it from
 * walking the disk. The agent wrote this code; it is not trusted with anything but its own
 * canvas.
 */
const floor = (preview: PreviewInfo) => (preview.themed ? THEMED_MIN_HEIGHT : MIN_HEIGHT);
const clamp = (value: number, preview: PreviewInfo) => Math.round(Math.min(MAX_HEIGHT, Math.max(floor(preview), value)));

/*
 * A preview is measured once and remembered.
 *
 * Without this, every visit to a conversation re-runs the measurement, and a card that settles at
 * 540 opens at 440 and jumps — which is exactly the kind of movement a transcript should never
 * have. Kept locally rather than in the session record because it describes this window: the same
 * conversation opened at another size would measure differently and should.
 */
const HEIGHT_KEY = "ly-preview-height:";

function recallHeight(preview: PreviewInfo): number | null {
	try {
		const raw = localStorage.getItem(`${HEIGHT_KEY}${preview.sessionId}/${preview.id}`);
		const value = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(value) ? clamp(value, preview) : null;
	} catch {
		return null;
	}
}

function rememberHeight(preview: PreviewInfo, height: number): void {
	try {
		localStorage.setItem(`${HEIGHT_KEY}${preview.sessionId}/${preview.id}`, String(height));
	} catch {
		// A full or disabled store costs a re-measure, nothing more.
	}
}

export function PreviewCard({ preview, startHeight, onShown }: {
	preview: PreviewInfo;
	/** The height the draft of this page got to (`PreviewDraft`): where the card starts, so the swap does not jump. */
	startHeight?: number;
	/** Once the page is on screen — the draft over it can go. */
	onShown?: () => void;
}) {
	const [collapsed, setCollapsed] = useState(false);
	const [nonce, setNonce] = useState(0);
	const [tall, setTall] = useState(false);
	const [ready, setReady] = useState(false);
	/** Loaded, and nothing heard for a while: shown at the default height, still listening. */
	const [gaveUp, setGaveUp] = useState(false);
	/** The page wants more room than a card in a transcript is allowed to take. */
	const [overflowing, setOverflowing] = useState(false);
	/**
	 * Opened to the whole page by the reader: how tall the card was before (`from`, where the way in
	 * stays put — see the button), how tall it is now, and how often it has followed the page since.
	 */
	const [full, setFull] = useState<{ from: number; height: number; adjustments: number } | null>(null);
	/** The page's latest height, whatever the card made of it. */
	const latest = useRef(0);
	const frame = useRef<HTMLIFrameElement>(null);
	// Straight from the last time this preview was measured, so the first frame is already right.
	const [measured, setMeasured] = useState<number | null>(() => recallHeight(preview) ?? (startHeight === undefined ? null : clamp(startHeight, preview)));
	/*
	 * Measurement state outlives a render, and has to.
	 *
	 * It used to live in the effect, which meant any re-render of the transcript restarted it —
	 * and since the frame is reused across those renders, the page had already loaded and would
	 * never report again. The measurement then timed out and every preview came back the same
	 * default height.
	 */
	const survey = useRef({ settled: false, tallest: 0, adjustments: 0, width: null as number | null, timer: null as ReturnType<typeof setTimeout> | null });
	/*
	 * A page of this screen's conversation, whichever screen has the focus.
	 *
	 * It used to follow the focus. The keyboard presses these buttons in a screen without giving it
	 * the focus, and the page became a tab of the conversation beside it. Its tab opens in the screen
	 * that owns it, see `reveal` in `useBrowserWorkspace`.
	 */
	const sessionId = useScopedSessionId();
	/*
	 * Between the press and the page being up. That can be seconds — the panel's code loads the first
	 * time, the page has to attach — and a button that shows nothing for that long reads as missed and
	 * gets pressed again.
	 */
	const opening = useSide((state) => state.browserTarget?.kind === "preview" && state.browserTarget.preview.id === preview.id && state.browserTarget.preview.sessionId === preview.sessionId);
	const show = () => {
		// Not disabled, which would fade the spinner to nothing; a second press just has nothing to add.
		if (opening) return;
		// The panel's tab cannot be told about a later theme change; it takes the one in force now.
		useSide.getState().openPreview({ ...preview, fragment: preview.themed ? previewFragment({ theme: previewTheme(null) }) : undefined }, sessionId);
	};

	/*
	 * The theme, handed over before the page's first paint and again whenever it changes.
	 *
	 * The address is settled in a layout effect, after the card is in the document: the page's
	 * `--background` is whatever is painted behind the card, and that cannot be read from a card
	 * that is not there yet. It is fixed from then on — a new address is a reload, and a reload is a
	 * page that loses whatever the reader had done in it. Later themes go in by message.
	 */
	const host = useRef<HTMLDivElement>(null);
	const { capturing, copied, copy } = usePreviewCopy(frame, latest);
	const tweaks = usePreviewTweaks(frame, nonce);
	const [tuning, setTuning] = useState(false);
	/** The adjustments last sent from the panel, so the same ones are not sent twice. */
	const [sentTweaks, setSentTweaks] = useState<string | null>(null);
	const tweaksKey = JSON.stringify(tweaks.changes.map(({ control, to }) => [control.id, to]));
	const [src, setSrc] = useState<string | null>(null);
	const [look, setLook] = useState<{ scheme: PreviewTheme["scheme"]; surface: string } | null>(null);
	const wear = (theme: PreviewTheme | undefined) =>
		setLook(theme ? { scheme: theme.scheme, surface: theme.vars["--background"] ?? "transparent" } : null);
	const url = previewUrl(preview);
	const { themed: wantsTheme } = preview;
	/*
	 * Keyed on the page and the run, not on the record object: the transcript is re-read from disk
	 * and hands back an equal record that is a new object, and a new address is a reload. A rerun is
	 * a reload on purpose, and takes the theme in force now rather than the one the first load had.
	 */
	useLayoutEffect(() => {
		const theme = wantsTheme ? previewTheme(host.current) : undefined;
		wear(theme);
		// What the reader left it at, read here and not kept: the page saves its own later states, and a rerun reads them again.
		setSrc(`${url}${previewFragment({ inline: true, theme, state: readPageState(preview.sessionId, preview.id) })}`);
	}, [url, wantsTheme, nonce, preview.sessionId, preview.id]);
	const postTheme = useCallback(() => {
		if (!preview.themed) return;
		const theme = previewTheme(host.current);
		wear(theme);
		frame.current?.contentWindow?.postMessage({ [THEME_MESSAGE]: theme }, "*");
	}, [preview]);
	useEffect(() => (preview.themed ? onAppearanceApplied(postTheme) : undefined), [preview.themed, postTheme]);

	/*
	 * A link in the page, opened where the reader's links go; or a button in it speaking for the
	 * reader (`plume.send`), said in this conversation. A state the page saves (`plume.setState`) is
	 * kept whenever it comes, and is the reader's — to be told to the model — on the same terms.
	 *
	 * The page cannot do either itself (see `withPreviewBridge`); it asks. Asked is not the same
	 * as clicked, though — a script can ask on load, or on a timer, as often as it likes. So the ask
	 * counts only while this frame has the focus and the reader has just used the app, which a page
	 * cannot arrange from inside its sandbox. It can still wait for the reader's next click
	 * anywhere in it, which is the same reach any link in it already has. A message is also said once
	 * however many times one press asks (`SEND_GAP_MS`).
	 */
	useEffect(() => {
		const timers = new Set<ReturnType<typeof setTimeout>>();
		const used = () =>
			document.activeElement === frame.current && (!navigator.userActivation || navigator.userActivation.isActive);
		function open(url: string) {
			const state = useApp.getState();
			if (state.settings?.browser?.openLinks === "builtin" && !url.startsWith("mailto:")) {
				void bridge.browser.command({ type: "open", url, sessionId, newTab: true }).catch((error: unknown) => state.notify(String(error), "error"));
			} else void bridge.system.openExternal(url);
		}
		let said = 0;
		function say(text: string) {
			if (!sessionId || Date.now() - said < SEND_GAP_MS) return;
			said = Date.now();
			sayFor(sessionId, text);
		}
		function onMessage(event: MessageEvent) {
			if (event.source !== frame.current?.contentWindow) return;
			const url = readOpenRequest(event.data);
			const text = readSendRequest(event.data);
			const state = readStateRequest(event.data);
			// Kept straight away whoever asked; only whether the model hears of it waits on the reader.
			const kept = state === null ? null : savePageState(preview.sessionId, preview.id, preview.title, state, used());
			const act = url ? () => open(url) : text ? () => say(text) : kept === "changed" ? () => markPageStatePending(preview.sessionId, preview.id) : null;
			if (!act) return;
			if (used()) return state === null ? act() : undefined;
			/*
			 * Asked once more, a moment later. The page runs in another process, and the click that
			 * focused and activated it reaches this document after the message it sent: measured in
			 * the real window, a link clicked straight after a click elsewhere in the app arrived
			 * with the focus still on the app's own button, and nothing opened.
			 */
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (used()) act();
			}, LINK_RECHECK_MS);
			timers.add(timer);
		}
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			for (const timer of timers) clearTimeout(timer);
		};
	}, [sessionId, preview.sessionId, preview.id, preview.title]);

	/*
	 * Grow to the page, within reason.
	 *
	 * The height comes from the page itself (see `withPreviewBridge` in the main process), which
	 * means it can move in response to being resized — a layout written against the viewport
	 * reports whatever it was just given, and taking that at face value would walk the card down
	 * the screen one message at a time. Three things stop that: the value is clamped, tiny
	 * differences are ignored, and there is a hard cap on how many times one preview may resize.
	 * A page whose height genuinely depends on its height settles at the cap rather than running.
	 */
	useEffect(() => {
		const state = survey.current;
		function commit(height: number) {
			state.settled = true;
			setMeasured(height);
			rememberHeight(preview, height);
		}
		function note(asked: number) {
			if (asked > MAX_HEIGHT + 8) setOverflowing(true);
		}
		function onMessage(event: MessageEvent) {
			// Identified by the window it came from — a sandboxed frame has no origin to check.
			if (event.source !== frame.current?.contentWindow) return;
			const data = event.data as Record<string, unknown> | null;
			const asked = data?.[HEIGHT_MESSAGE];
			if (typeof asked !== "number" || !Number.isFinite(asked)) return;
			latest.current = asked;
			/*
			 * Opened, the card is the page's height, both ways — a tab switched in the page may be shorter.
			 * Capped like the settled card is: a box sized in `vh` grows with every height it is given.
			 */
			setFull((open) => (open && open.adjustments < MAX_ADJUSTMENTS && Math.abs(asked - open.height) > 2 ? { ...open, height: Math.max(floor(preview), asked), adjustments: open.adjustments + 1 } : open));
			const width = data?.[WIDTH_KEY];
			const resized = typeof width === "number" && state.width !== null && width !== state.width;
			if (typeof width === "number") state.width = width;

			if (!state.settled) {
				/*
				 * Keep listening for a moment before deciding.
				 *
				 * The first number out of a page is almost never its final size — it arrives while
				 * stylesheets are still landing, web fonts have not swapped and entrance animations
				 * are mid-flight, and it describes a document that has not finished becoming
				 * itself. Every report in this window describes the same content, so the largest of
				 * them is the one that saw all of it.
				 */
				state.tallest = Math.max(state.tallest, asked);
				note(asked);
				state.timer ??= setTimeout(() => {
					/*
					 * Too small to be a measurement of anything.
					 *
					 * A page built entirely out of percentages has no height of its own to report,
					 * and what comes back is the sum of a few collapsed boxes. Better to give it
					 * the default and let it fill that than to squeeze it into its own collapse.
					 * A themed page is short when it is short — see `THEMED_MIN_HEIGHT`.
					 */
					commit(state.tallest < (preview.themed ? THEMED_MIN_HEIGHT : MEANINGFUL_HEIGHT) ? DEFAULT_HEIGHT : clamp(state.tallest, preview));
				}, PROBE_SETTLE_MS);
				return;
			}
			/*
			 * After that, the page may only ask for more — unless it was measured at a new width, which
			 * is a new measurement. See `followHeight`. Growth at the same width is content that would
			 * otherwise be cut off: a detail panel opening, a list loading.
			 */
			if (resized) {
				state.adjustments = 0;
				// What was cut off at the narrow width may fit at this one.
				setOverflowing(asked > MAX_HEIGHT + 8);
			} else note(asked);
			setMeasured((current) => {
				if (current === null) return current;
				const next = followHeight({ current, next: clamp(asked, preview), resized, adjustments: state.adjustments });
				if (next === null) return current;
				state.adjustments++;
				rememberHeight(preview, next);
				return next;
			});
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [preview]);

	/*
	 * Loaded, and nothing heard for a while: show the page at the default height, and keep listening.
	 *
	 * Counted from the load, not from the mount. The frame runs in a process of its own, and on a
	 * busy machine starting it took longer than the whole wait: the clock ran out before the page
	 * existed, the default was committed as if measured — settled and remembered, over a height
	 * recalled or handed over by the draft — and the real height that came a moment later could only
	 * make the card taller (`followHeight`). Those previews stayed at 440. Nor is the default a
	 * measurement now: nothing is settled or remembered, and the first report that does arrive is
	 * still taken as the first, free to make the card shorter.
	 */
	useEffect(() => {
		if (!ready) return;
		const state = survey.current;
		const giveUp = setTimeout(() => {
			// A report in hand settles within PROBE_SETTLE_MS; showing the default first would only add a jump.
			if (!state.settled && state.timer === null) setGaveUp(true);
		}, PROBE_TIMEOUT_MS);
		return () => clearTimeout(giveUp);
	}, [ready]);

	// Asking for more space is a decision the page does not get to overrule.
	const height = full ? full.height : tall ? MAX_HEIGHT : (measured ?? DEFAULT_HEIGHT);
	// Held back until it has been measured, or until it is clear nothing is coming, so the probe height is never a frame anyone sees.
	const visible = ready && (measured !== null || gaveUp);
	const shown = useRef(onShown);
	shown.current = onShown;
	useEffect(() => {
		if (visible) shown.current?.();
	}, [visible]);

	/*
	 * A themed page is part of the reply: no frame, on the conversation's own background, its left
	 * edge on the text's. A page from before the theme existed keeps its card — it paints its own
	 * white page, and without an edge that is a white slab dropped into the conversation.
	 */
	const themed = look !== null;
	return (
		<div>
		<button
			type="button"
			aria-expanded={!collapsed}
			aria-label={translate(collapsed ? "preview.expand" : "preview.collapse", { title: preview.title })}
			data-ly-preview-toggle
			data-expandable=""
			data-open={collapsed ? undefined : ""}
			className="ly-flow-row ly-scroll w-full cursor-pointer text-left text-label text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink-muted"
			onClick={() => setCollapsed((value) => !value)}
		>
			<span className="ly-flow-lead"><AppWindow size={13} strokeWidth={1.8} aria-hidden /></span>
			<span className="ly-flow-summary"><ScrollText text={preview.title} /></span>
			<ChevronRight size={12} strokeWidth={2} className="ly-flow-chevron" aria-hidden />
		</button>
		{/* Keep the frame's layout and state while folding, including measurements when the column resizes. */}
		<Collapse open={!collapsed} keepMounted bodyClassName="pt-1.5 pl-[22px]">
		<div
			ref={host}
			data-ly-preview={themed ? "themed" : "card"}
			style={{ height }}
			/*
			 * No animation while measuring.
			 *
			 * The probe works by observing the page at a deliberately small height, and an animated
			 * height is not at that height yet — it is somewhere on the way there. The page loaded
			 * mid-transition and reported the height it happened to see, which was the old one.
			 *
			 * Square while copying: the page moves through the card a slice at a time
			 * (`usePreviewCopy`), and round corners would cut into every slice.
			 *
			 * The height is the page's, the border on top of it (`box-content`). Inside the border, the
			 * 2px of slack the page adds to what it asks for went to the border, and a page sized to
			 * exactly its own height sat exactly at the frame's edge — where filling the frame and merely
			 * fitting it look the same to the measurement (`MEASURE_HEIGHT`): a `height: 360px` page
			 * reopened at its remembered 362 measured 256, and dipped before coming back. A themed page
			 * has no border; nor does a draft hand its height to one that has: a draft is drawn only for a
			 * page written in the call, and only a file from disk is shown unthemed.
			 */
			className={`relative overflow-hidden ${themed ? "" : `box-content border border-line-soft ${capturing ? "" : "rounded-xl"}`} ${
				measured === null ? "" : "transition-[height] duration-[var(--ly-t-slow)]"
			}`}
		>
			{/*
			 * The frame fades in over the card's own colour rather than appearing on white.
			 *
			 * Every preview starts as a blank document, and a blank document is white — which on a
			 * dark theme is a flash bright enough to be the most noticeable thing about the whole
			 * feature. Holding it back until the page has painted costs nothing and removes it.
			 */}
			<div className={`h-full w-full ${themed ? "" : "bg-card"}`}>
				{/* Not mounted before its address is settled: a frame with no `src` loads a blank page and reports it loaded. */}
				{src && (
					<iframe
						ref={frame}
						key={nonce}
						/*
						 * `#ly-inline` tells the page it is in the transcript rather than the panel, and
						 * a fragment does it without touching the request — same URL, same file, one
						 * fetch. The injected stylesheet keys off it to stop the page scrolling here.
						 */
						src={src}
						title={preview.title}
						sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
						onLoad={() => {
							setReady(true);
							// A theme that changed while the page was loading never reached it.
							postTheme();
						}}
						/*
						 * The frame's scheme is the page's. A frame whose scheme differs from its
						 * document's paints an opaque canvas under it, and a themed page would sit on a
						 * white or black slab instead of on the conversation.
						 */
						style={look ? { colorScheme: look.scheme } : undefined}
						className={`block h-full w-full transition-opacity duration-[var(--ly-t-base)] ${visible ? "opacity-100" : "opacity-0"}`}
					/>
				)}
			</div>

			{/*
			 * Floating over the page, faint until you go for them.
			 *
			 * Elsewhere in the app controls like these stay hidden until the pointer is on what they
			 * act on. Not here: the page fills the card, so nearly every position the pointer can
			 * take is inside a cross-process frame, and whether that hover reaches this document is
			 * not something that could be established either way. Rather than stake the only way to
			 * rerun or reopen a preview on it, they stay — quiet enough to read as part of the page,
			 * and solid the moment the pointer arrives, which is a hover this document does own.
			 */}
			{/*
			 * Say so when there is more below, and open it here when pressed.
			 *
			 * The page does not scroll inside the card — that is what stops it swallowing the wheel
			 * and jittering against its own edge — so a page taller than the ceiling is folded at it.
			 * Pressed, the card takes the page's whole height in place; the panel is the button at the
			 * top right, for when the reader wants it out of the conversation.
			 *
			 * Opened, the button fades but stays where it was pressed rather than going with the card's
			 * bottom or leaving: the transcript keeps what was pressed still while it grows
			 * (`useFollowBottom.hold`), and a button that moved or left would let a transcript at its
			 * end follow the growth down to the page's last line, past everything just opened.
			 */}
			{((overflowing && !tall) || full) && !capturing && (
				<button
					type="button"
					data-ly-tip={translate("preview.longer")}
					aria-label={translate("preview.longer")}
					aria-hidden={full ? true : undefined}
					inert={full ? true : undefined}
					onClick={() => setFull({ from: height, height: Math.max(height, latest.current), adjustments: 0 })}
					style={{
						...(look ? { ["--ly-preview-fade" as string]: look.surface } : {}),
						...(full ? { top: `calc(${full.from}px - 3.5rem)` } : {}),
					}}
					// Into whatever is behind the page: the card's own colour, or the conversation's when there is no card.
					className={`absolute inset-x-0 flex h-14 items-end justify-center bg-gradient-to-t transition-opacity duration-[var(--ly-t-base)] ${full ? "pointer-events-none opacity-0" : "bottom-0"} ${themed ? "from-(--ly-preview-fade) via-(--ly-preview-fade)/80" : "from-card via-card/80"} to-transparent pb-2`}
				>
					{/* Solid, not frosted: this card scrolls inside the transcript, and a masked scroller
					    is a backdrop root — the blur would never arrive. See `.ly-glass-solid`. */}
					<span className="ly-glass-solid grid h-6 w-6 place-items-center rounded-full text-ink-muted transition-colors hover:text-ink">
						<ChevronsDown size={13} strokeWidth={2} aria-hidden />
					</span>
				</button>
			)}

			{/* Solid for the same reason as above — and this one sits over an arbitrary rendered page,
			    where a translucent strip with nothing blurred behind it is the least readable of all. */}
			<div className={`ly-glass-solid absolute top-2 right-2 flex items-center gap-0.5 rounded-lg p-0.5 ${capturing ? "invisible" : ""} opacity-45 transition-opacity duration-[var(--ly-t-quick)] hover:opacity-100 has-[:focus-visible]:opacity-100`}>
				{/*
				 * Taller, because the frame cannot ask for a size.
				 *
				 * A page laid out against the viewport — which is most games and most dashboards —
				 * reports exactly the height it was given, so there is nothing to measure and grow
				 * to. The default suits a diagram or a form; anything built to fill a screen gets
				 * cropped at the bottom, and this is the one click that fixes it.
				 *
				 * Not on a themed page. It is written to size itself to its content (no `100vh`, see
				 * `previewTool`), so it is already as tall as it is: the click only added blank space
				 * under it — and with no card edge, a blank stretch of conversation with nothing to say
				 * where the page ends. More room for a page like that is the panel. Opened to the whole
				 * page from the fold, though, it is the way back, and a themed page has no other.
				 */}
				{(!themed || full) && (
					<IconButton
						icon={tall || full ? <Minimize2 size={12} strokeWidth={1.9} /> : <Maximize2 size={12} strokeWidth={1.9} />}
						label={translate(tall || full ? "preview.fitHeight" : "preview.maximise")}
						size="sm"
						tipSide="top"
						onClick={() => {
							// Opened to the whole page is bigger still, and this is the way back from it too.
							if (full) setFull(null);
							else setTall((value) => !value);
						}}
					/>
				)}
				<IconButton
					icon={<RotateCw size={12} strokeWidth={1.9} />}
					label={translate("preview.rerun")}
					size="sm"
					tipSide="top"
					onClick={() => {
						/*
						 * A fresh run may draw something a different size, so measure it again — in the
						 * same record, reset in place. The listener holds on to that object; swapping in
						 * a new one left it reading the old, already settled one, and the page never
						 * showed again. The card keeps its height meanwhile: dropping to the default and
						 * back was a jump in the conversation for a page that is usually the same size.
						 */
						const state = survey.current;
						if (state.timer) clearTimeout(state.timer);
						Object.assign(state, { settled: false, tallest: 0, adjustments: 0, timer: null });
						setOverflowing(false);
						setFull(null);
						setReady(false);
						setGaveUp(false);
						setNonce((value) => value + 1);
					}}
				/>
				{tweaks.groups.length > 0 && (
					<IconButton
						icon={<SlidersHorizontal size={12} strokeWidth={1.9} />}
						label={translate("preview.tweak")}
						active={tuning}
						size="sm"
						tipSide="top"
						onClick={() => setTuning((open) => !open)}
					/>
				)}
				<IconButton
					icon={copied ? <Check size={12} strokeWidth={2.2} className="ly-pop text-ok" /> : <Copy size={12} strokeWidth={1.9} />}
					label={translate(copied ? "preview.copiedImage" : "preview.copyImage")}
					size="sm"
					tipSide="top"
					onClick={() => void copy()}
				/>
				<IconButton
					icon={opening ? <ActionSpinner size={12} /> : <ExternalLink size={12} strokeWidth={1.9} />}
					label={translate(opening ? "preview.openingInPanel" : "preview.openInPanel")}
					size="sm"
					tipSide="top"
					onClick={show}
				/>
			</div>
		</div>
		{tuning && tweaks.groups.length > 0 && (
			<PreviewTweaks
				groups={tweaks.groups}
				current={tweaks.current}
				changed={tweaks.changes.length}
				sent={sentTweaks === tweaksKey}
				onSet={tweaks.set}
				onReset={tweaks.reset}
				onPeek={tweaks.peek}
				onSend={() => {
					if (!sessionId || !tweaks.changes.length) return;
					const { text, spoken } = tweakMessage(preview.title, tweaks.changes);
					sayFor(sessionId, text, spoken);
					setSentTweaks(tweaksKey);
				}}
			/>
		)}
		</Collapse>
		</div>
	);
}
