/**
 * The page a `preview` call is writing, drawn as it is written.
 *
 * A page is thousands of tokens, and the model writes them for minutes: measured on real sessions, a
 * page of 17–22 thousand characters in a reply of 8–13 thousand output tokens, with nothing in the
 * conversation but a line saying a preview was being made. So the page comes up as it is written —
 * a placeholder while the styles are written (markup without them is a flash of raw text), then the
 * page itself, growing — and the finished page takes its place once it has loaded (`PreviewCall`).
 *
 * No script runs here. A script is only ever half written while the page is, and what it would do
 * to the document is the finished page's business: the frame is sandboxed without `allow-scripts`.
 * It is same-origin so the app can write into it — morphing the new markup in rather than reloading
 * the frame, which flickered several times a second and restarted every animation (`morph`). A page
 * built by its script shows its styles and nothing else until then; the tool's description asks for
 * markup first for that reason.
 *
 * Before there is a page, the call is its ordinary tool row (`placeholder`, from the caller), not a
 * box of the page's height with a label in its middle: that read as a page that had failed to load,
 * and an empty 160px in the conversation for as long as the styles took. The row gives way to the
 * page once there is something to show.
 *
 * `srcdoc`, which inherits this window's content policy: no remote images or stylesheets in the draft.
 * The finished page is served from `ly-preview://` with its own and has them.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { translate } from "../../i18n/translate.ts";
import { morph } from "../../lib/morph.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { onAppearanceApplied } from "../settings/index.ts";
import { PREVIEW_MAX_HEIGHT, PREVIEW_THEMED_BASE } from "../../../shared/preview.ts";
import { draftPhase, draftSize, type DraftDocument } from "./preview-draft.ts";
import { previewTheme } from "./preview-theme.ts";

/** The card's floor, the same as the finished page's (`PreviewCard`). */
const MIN_HEIGHT = 160;
/** How often the draft takes in what has been written: a parse per streamed token would be hundreds a second. */
const REDRAW_MS = 120;
/** The frame's own document. Its styles are filled in by the app; the page goes into its body. */
const SHELL = '<!doctype html><html><head><meta charset="utf-8"><style id="ly-base"></style><style id="ly-page"></style></head><body></body></html>';

export function PreviewDraft({ document: page, placeholder, complete, onHeight }: {
	document: DraftDocument;
	/** What stands for the call until the page has something to show: its tool row. */
	placeholder: ReactNode;
	/** The arguments are all in: what remains is the app checking the page before it is shown. */
	complete: boolean;
	/** The height the draft got to, so the finished page can start there rather than jump. */
	onHeight?: (height: number) => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [loaded, setLoaded] = useState(false);
	const [shown, setShown] = useState(false);
	const [height, setHeight] = useState(MIN_HEIGHT);
	const latest = useRef(page);
	latest.current = page;

	// The theme the finished page will wear, on the draft's own `:root`; again whenever it changes.
	useLayoutEffect(() => {
		if (!loaded) return;
		const wear = () => {
			const sheet = frame.current?.contentDocument?.getElementById("ly-base");
			if (!sheet) return;
			const theme = previewTheme(host.current);
			const vars = Object.entries(theme.vars).map(([name, value]) => `${name}:${value};`).join("");
			// No scrolling inside the card, as for the finished page: it grows to fit instead.
			sheet.textContent = `:root{color-scheme:${theme.scheme};${vars}}${PREVIEW_THEMED_BASE}html,body{overflow:hidden}`;
		};
		wear();
		return onAppearanceApplied(wear);
	}, [loaded]);

	useEffect(() => {
		if (!loaded) return;
		const draw = () => {
			const target = frame.current?.contentDocument;
			if (!target) return;
			const { html, css } = latest.current;
			/*
			 * Without the tag being written. A parser at the end of its input keeps a lone `<` as text:
			 * the first piece of a page, `<!doctype html><`, drew as a page holding one `<`.
			 */
			const parsed = new DOMParser().parseFromString(html.replace(/<[^>]*$/, ""), "text/html");
			// Every stylesheet in one place, in order — the ones in the body included — so the body holds only the page.
			const styles = [...parsed.querySelectorAll("style")];
			const sheet = target.getElementById("ly-page");
			const text = [...css, ...styles.map((style) => style.textContent ?? "")].join("\n");
			if (sheet && sheet.textContent !== text) sheet.textContent = text;
			for (const node of parsed.body.querySelectorAll("style, script, link, meta, title")) node.remove();
			morph(target.body, parsed.body);
			for (const name of ["class", "lang", "dir"]) {
				const value = parsed.documentElement.getAttribute(name);
				if (value === null) target.documentElement.removeAttribute(name);
				else target.documentElement.setAttribute(name, value);
			}
			// The page shows once its styles are in and it has something to show; until then, the placeholder.
			const ready = draftPhase(html) !== "styles" && (parsed.body.children.length > 0 || Boolean(parsed.body.textContent?.trim()));
			setShown((was) => was || ready);
			// Grows only: a page being written only gets longer, and a card that shrank and grew back would bounce.
			const wanted = Math.min(PREVIEW_MAX_HEIGHT, Math.max(MIN_HEIGHT, target.documentElement.scrollHeight));
			setHeight((was) => Math.max(was, wanted));
		};
		draw();
		// Written out: one last draw of the whole thing, and nothing more is coming.
		if (complete) return;
		const timer = setInterval(draw, REDRAW_MS);
		return () => clearInterval(timer);
	}, [loaded, complete]);

	useEffect(() => onHeight?.(height), [height, onHeight]);

	const phase = complete ? "checking" : draftPhase(page.html);
	const status = `${translate(`preview.draft.${phase}`)} · ${draftSize(page)}`;
	return (
		<div ref={host} data-ly-preview-draft={shown ? "page" : "placeholder"} aria-busy="true" className="relative">
			{!shown && placeholder}
			{/* Laid out from the first character so it can be drawn into; it takes room only once it shows. */}
			<div style={{ height: shown ? height : 0 }} className={`relative overflow-hidden transition-[height] duration-[var(--ly-t-slow)] ${shown ? "ly-enter my-2.5" : ""}`}>
				<iframe
					ref={frame}
					srcDoc={SHELL}
					title={status}
					sandbox="allow-same-origin"
					tabIndex={-1}
					onLoad={() => setLoaded(true)}
					style={{ height: Math.max(height, MIN_HEIGHT) }}
					className={`pointer-events-none block w-full transition-opacity duration-[var(--ly-t-base)] ${shown ? "opacity-100" : "opacity-0"}`}
				/>
				{shown && (
					<div role="status" className="ly-glass-solid absolute top-2 right-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption text-ink-muted">
						<ActionSpinner size={12} />
						<span>{status}</span>
					</div>
				)}
			</div>
		</div>
	);
}
