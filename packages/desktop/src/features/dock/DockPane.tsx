/**
 * One pane: a header and whatever it holds, positioned absolutely inside the dock.
 *
 * Absolute rather than laid out in a flex tree, because the flat list is what keeps a pane from
 * being unmounted when the layout changes — see the note at the top of `layout.ts`. The practical
 * consequence is that a change of layout retains the same content. PaneSurface lays it out once
 * at its destination and composites the movement, without reflowing every intermediate width.
 */

import { useLayout } from "../../app/layout.tsx";
import { PaneHeader } from "./PaneHeader.tsx";
import { PaneSurface } from "./PaneSurface.tsx";
import { pct } from "./css.ts";
import { cardRoom, HEADER_HEIGHT, PANE_INSET, panePaintMinWidth } from "./geometry.ts";
import type { Box } from "./layout.ts";
import type { PaneKind } from "./tree.ts";

export function DockPane({
	kind,
	box,
	label,
	icon,
	maximized,
	hidden,
	quietEntrance,
	actions,
	title,
	inset,
	insetEnd,
	onToggleMaximized,
	onPopOut,
	onFocus,
	chrome = true,
	reserveHeader = true,
	customHeader,
	children,
}: {
	kind: PaneKind;
	box: Box;
	label: string;
	icon?: React.ReactNode;
	maximized: boolean;
	/**
	 * Behind another pane in the collapsed layout.
	 *
	 * Opacity and inertness retain layout as well as content. display:none invalidates the
	 * terminal grid and every row's measurements; inherited visibility restyles every descendant.
	 */
	hidden: boolean;
	/** 挂上来时不淡入，见 `PaneSurface`。 */
	quietEntrance?: boolean;
	/** Controls belonging to what the pane holds — the conversation's panel buttons. */
	actions?: React.ReactNode;
	/** Drawn in the header in place of the name — see `PanelDefinition.header`. */
	title?: React.ReactNode;
	/** Room for the traffic lights, when this pane covers the window's top-left corner. */
	inset?: number;
	/** And for the system's own buttons at the other end, on Windows and Linux. */
	insetEnd?: number;
	/** Absent where full screen is not on offer — the dock decides; see `DockView`. */
	onToggleMaximized?: () => void;
	/** Leave this dock for a real window. */
	onPopOut?: () => void;
	onFocus: () => void;
	/**
	 * Conversation tiles are independent screens. When more than one is showing, each paints
	 * its own title bar, and this shared dock chrome would sit above them as a fifth strip.
	 */
	chrome?: boolean;
	/**
	 * Whether the card keeps its header's 44px at the top. False for a conversation whose title bar
	 * the window's toolbar draws: the header layer stays, and takes no room.
	 */
	reserveHeader?: boolean;
	customHeader?: React.ReactNode;
	children: React.ReactNode;
}) {
	/*
	 * In the window frame the panes are flush regions of one surface, divided by hairlines (see the
	 * note on the card below). `edges` are the sides that border a neighbour, where the hairline goes.
	 */
	const { framed } = useLayout();
	const flat = framed;
	const edges = { left: box.left > 0.001, top: box.top > 0.001 };
	/** Where the card's inside starts within the pane's box: its inset and its border. */
	const edge = flat ? 0 : PANE_INSET + 1;
	const edgeRoom = (room?: number) => (room ? cardRoom(room) : room);
	const paintMinWidth = panePaintMinWidth(kind, box.width, maximized);

	return (
		<PaneSurface
			isHidden={hidden}
			quietEntrance={quietEntrance}
			data-dock-pane={kind}
			data-ly-pane-slot={customHeader ? "conversation" : undefined}
			// Focus follows the click for the benefit of the collapsed layout and the keyboard;
			// it costs nothing here and means the two forms agree about which pane is current.
			onPointerDownCapture={onFocus}
			// `absolute` against the dock in percentages, so a window resize is the browser's problem.
			style={{
				left: pct(box.left),
				top: pct(box.top),
				width: pct(box.width),
				height: pct(box.height),
				/*
				 * The pixel floor, which a share cannot express.
				 *
				 * `fitSizes` keeps every pane in a row at its floor except the first, which
				 * absorbs whatever the row cannot hold — so on a dock too narrow for the
				 * arrangement, the first pane's *box* is smaller than the pane may be drawn.
				 * This is what draws it at its floor anyway: it extends past its box, and
				 * the pane beside it — a panel, and so a layer above — is drawn over the
				 * overhang.
				 *
				 * Which is the whole point. The conversation stays laid out at the width it
				 * says it is, with its right-hand side covered, rather than reflowing its
				 * text into a column two words wide. Nothing else in the row moves.
				 *
				 * Width only. A vertical overhang would cover either the composer at the
				 * bottom of the conversation or the title bar of the pane below — and those
				 * are the controls you would need in order to undo it. `fitSizes` declines
				 * to overlap a column for the same reason.
				 *
				 * Not while a pane fills the dock — full screen, or a lone conversation: it
				 * has to shrink with the window. See `panePaintMinWidth`.
				 */
				...(paintMinWidth === undefined ? null : { minWidth: paintMinWidth }),
			}}
			// Panels sit above the conversation, and the splitters sit above both.
			/*
			 * Which panel this is, so the stylesheet can tell a code surface from a chrome one.
			 *
			 * The panes that show code — the editor, its tree, the terminal, a diff — take the code
			 * theme's background for the *whole card*, header and tab strip included. Colouring only
			 * the text area is what made the pane read as two things stacked: a white title bar with
			 * a warm rectangle below it, rather than one editor.
			 */
			data-pane={kind}
			className={`ly-dock-pane group/pane absolute flex min-w-0 flex-col ${kind !== "conversation" ? "z-10" : "z-0"}`}
			/*
			 * The title bar sits inside the card, centred in the card's top 44px.
			 *
			 * Flat, it lies over the hairline rather than stepping past it. Stepping past it moved the title
			 * a pixel whenever the line came or went — on every full screen and back — and put the bar's
			 * centre a pixel off its row. The bar is transparent, so the line still shows through it.
			 */
			header={chrome ? <div className="ly-dock-chrome absolute inset-x-0 top-0 z-[1]" style={{ margin: flat ? 0 : edge, background: "transparent" }}>
				{customHeader ?? <PaneHeader
					kind={kind}
					label={label}
					icon={icon}
					maximized={maximized}
					hideTitle={kind === "conversation"}
					title={title}
					actions={actions}
					inset={edgeRoom(inset)}
					insetEnd={edgeRoom(insetEnd)}
					onToggleMaximized={onToggleMaximized}
					onPopOut={onPopOut}
				/>}
			</div> : null}
		>
			{/*
			 * One surface divided by hairlines, in the window frame (ADR-0038).
			 *
			 * The panes were each a floating card with 4px of window between them. Inside the frame —
			 * where the sidebar and the content are already one panel — that was a card inside a card,
			 * and opening a terminal or a second screen put more gaps and corners into the content than
			 * content. So in the frame a pane is flush with its neighbours and a 1px line marks the
			 * boundary, as the sidebar's is marked. `ly-dock-card` stays for the colours it carries (the
			 * terminal's and the editor's code background); `ly-dock-flat` takes its edge, corners and
			 * shadow away.
			 *
			 * `overflow-hidden` is what makes a card's radius real: without it a scroller inside paints
			 * its own square corners straight over the rounded ones.
			 */}
			<div
				className={`ly-dock-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${flat ? "ly-dock-flat" : ""}`}
				data-edge-left={flat && edges.left ? "" : undefined}
				data-edge-top={flat && edges.top ? "" : undefined}
				style={flat ? undefined : { margin: PANE_INSET }}
			>
			{/* Controls keep their endpoint geometry while this retained surface composites its resize. */}
			{chrome && reserveHeader && <div aria-hidden className="shrink-0" style={{ height: HEADER_HEIGHT }} />}
			<div data-dock-content={kind} className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
			</div>
		</PaneSurface>
	);
}
