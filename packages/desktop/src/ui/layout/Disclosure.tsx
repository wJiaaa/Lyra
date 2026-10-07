/**
 * A section that folds away, and the one place the app decides what that looks like.
 *
 * There were three spellings of this before it existed: a `▾` character that swapped to `▸`, a
 * chevron that appeared and disappeared, and a block that was simply rendered or not. All three
 * read as different mechanisms rather than as one idea, and the character version was the worst of
 * them — a glyph is drawn at whatever weight the font feels like and cannot rotate, so opening was
 * a substitution rather than a movement.
 *
 * A fourth spelling crept back in after that: the browser's own `<details>`, in three settings
 * pages. It draws a system triangle at the platform's size and weight, snaps open with no
 * transition, and puts the hit target on the eleven pixels of the marker. Next to everything else
 * on the page it looked pasted in from another app, which is what it was.
 *
 * What this settles:
 *
 *   - the chevron rotates rather than being replaced, so the state is one object in two positions;
 *   - the body unfolds to its own height (`ly-reveal`), so closing is the same gesture as opening
 *     rather than a cut;
 *   - the header is a real button covering the whole row, so the hit target is the row and not the
 *     eleven pixels of the arrow;
 *   - a count sits next to the title rather than inside it, because "活动 3" is a heading and a
 *     quantity, not a five-character heading.
 */

import { ChevronRight } from "../icons/index.ts";
import { type ReactNode, useState } from "react";

/**
 * Three settings for the same fold.
 *
 * `section` is a heading with a rule above it, for the parts of a detail view; `compact` is an
 * inline reading with no chrome of its own; `framed` is a box in the flow of the content — the
 * shape `<details>` takes in a README, and what an "advanced" block at the foot of a form is.
 */
const LOOK = {
	section: {
		root: "border-t border-line-soft first:border-t-0",
		head: "",
		button: "py-2.5",
		title: "text-label font-medium",
		body: "pb-3",
	},
	compact: {
		root: "",
		head: "",
		button: "py-1",
		title: "text-detail",
		body: "pl-3.5",
	},
	framed: {
		root: "overflow-hidden rounded-[10px] border border-line-soft",
		head: "pr-3",
		button: "py-2 pl-3",
		/*
		 * No size of its own. A framed fold sits inside prose whose size the page has already
		 * chosen — a README rendered at label size, a message at body size — and a heading one step
		 * off from the text around it reads as a second document pasted in.
		 */
		title: "",
		body: "px-3 pb-3",
	},
} as const;

/*
 * Either the caller owns the state or nobody needs to.
 *
 * A "component stack" behind a crash, an "advanced" block at the foot of a form: nothing else on
 * the page cares whether these are open, and making every such caller hold a `useState` for the
 * privilege is how three of them ended up reaching for `<details>` instead. Given `open`, the
 * caller decides; given neither, the fold remembers for itself. Half of each is a type error.
 */
type Control =
	| { open: boolean; onToggle: () => void; defaultOpen?: never }
	| { open?: never; onToggle?: never; defaultOpen?: boolean };

export function Disclosure({
	title,
	count,
	trailing,
	children,
	variant = "section",
	...control
}: {
	title: ReactNode;
	/** Shown after the title. Zero is worth saying; undefined is not. */
	count?: number;
	/** Controls that belong to the section rather than to its contents — an edit button, a link. */
	trailing?: ReactNode;
	children: ReactNode;
	variant?: keyof typeof LOOK;
} & Control) {
	const [selfOpen, setSelfOpen] = useState(control.defaultOpen ?? false);
	const open = control.open ?? selfOpen;
	const toggle = control.onToggle ?? (() => setSelfOpen((was) => !was));
	const look = LOOK[variant];

	return (
		<section className={look.root}>
			<div className={`flex items-center gap-1 ${look.head}`}>
				{/*
				 * No filled hover.
				 *
				 * `ly-item` is the list-row treatment — a block of colour saying "this whole strip is
				 * one selectable thing". A section heading is not that: it sits inside the content it
				 * labels, and a band of grey sweeping across the page as the pointer passes reads as
				 * something being selected rather than as a heading noticing you.
				 *
				 * The affordance is the chevron and the title going darker, which is as much as a
				 * heading needs to say it can be pressed.
				 */}
				<button
					type="button"
					onClick={toggle}
					aria-expanded={open}
					className={`group/disclosure flex min-w-0 flex-1 items-center gap-1.5 pr-1.5 text-left ${look.button}`}
				>
					{/*
					 * One chevron, turned. Right when closed, down when open — the same rotation a
					 * disclosure triangle has made since before any of this, and the reason it reads
					 * without a label.
					 */}
					<ChevronRight
						size={13}
						strokeWidth={2.2}
						className="shrink-0 text-ink-faint transition-[transform,color] duration-[var(--ly-t-base)] ease-[var(--ly-e-out)] group-hover/disclosure:text-ink-muted"
						style={{ transform: open ? "rotate(90deg)" : undefined }}
					/>
					<span className={`${look.title} text-ink-muted transition-colors duration-[var(--ly-t-quick)] group-hover/disclosure:text-ink`}>
						{title}
					</span>
					{count !== undefined && <span className="text-detail text-ink-faint tabular-nums">{count}</span>}
				</button>

				{trailing}
			</div>

			<div className="ly-reveal" data-open={open} aria-hidden={!open} inert={!open}>
				<div>
					<div className={look.body}>{children}</div>
				</div>
			</div>
		</section>
	);
}
