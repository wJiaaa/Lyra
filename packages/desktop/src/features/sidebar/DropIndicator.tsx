/**
 * Drop indicator with a trailing circle mark, indicating where dragged item will be inserted.
 */

import { createPortal } from "react-dom";
import { Folder, MessageSquare } from "../../ui/icons/index.ts";
import type { DraggingItem } from "./reorder-context.ts";

export function DropLineIndicator({ placement }: { placement: "before" | "after" }) {
	return (
		<div
			className={`pointer-events-none absolute right-1 left-1 z-30 h-[2px] bg-accent ${
				placement === "before" ? "-top-[1px]" : "-bottom-[1px]"
			}`}
		>
			<span className="absolute -top-[2px] -left-1 h-1.5 w-1.5 rounded-full bg-accent shadow-sm" />
		</div>
	);
}

export function CarriedPill({ item, pointer }: { item: DraggingItem; pointer: { x: number; y: number } }) {
	return createPortal(
		<div
			style={{
				left: `${pointer.x + 12}px`,
				top: `${pointer.y + 12}px`,
			}}
			className="ly-glass-solid pointer-events-none fixed z-[100] flex max-w-[200px] items-center gap-2 rounded-lg border border-line-soft px-2.5 py-1.5 shadow-lg shadow-black/20 backdrop-blur-md select-none"
		>
			{item.kind === "project" ? (
				<Folder size={14} strokeWidth={1.8} className="shrink-0 text-accent" />
			) : (
				<MessageSquare size={14} strokeWidth={1.8} className="shrink-0 text-accent" />
			)}
			<span className="truncate text-detail font-medium text-ink">{item.title}</span>
		</div>,
		document.body,
	);
}
