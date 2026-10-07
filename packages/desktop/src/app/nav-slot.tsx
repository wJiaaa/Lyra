/**
 * The sidebar of the views that are not conversations.
 *
 * With the rail beside it, the sidebar belongs to whichever place the rail is on: the conversation
 * list for 对话, and for 拉取请求, 定时任务 and 插件 whatever that view puts there — its list, its
 * filters. A view draws that part itself, into a slot here, through a portal: its state stays in
 * one component, and the sidebar is only where some of it is drawn.
 *
 * Without the rail — a narrow window — the sidebar is a drawer reached from every view
 * alike, holding the conversations and the way to the other places, so it stays the conversation
 * list and each view draws its own parts in its own page, as before.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useLayout } from "./layout.tsx";

/** The views that bring a sidebar of their own. */
export type SlotView = "pull-requests" | "scheduled" | "plugins";
const SLOT_VIEWS: readonly SlotView[] = ["pull-requests", "scheduled", "plugins"];

interface SlotRegistry {
	/** Whether the rail is drawn, and so whether the sidebar is the views' to fill. */
	rail: boolean;
	slots: Partial<Record<SlotView, HTMLElement>>;
	register: (view: SlotView, element: HTMLElement | null) => void;
}

const Slots = createContext<SlotRegistry | null>(null);

/** Around both the sidebar and the views, which are siblings — the slots live in one, the portals in the other. */
export function NavSlotProvider({ children }: { children: React.ReactNode }) {
	const { rail } = useLayout();
	const [slots, setSlots] = useState<SlotRegistry["slots"]>({});
	const register = useCallback((view: SlotView, element: HTMLElement | null) => {
		setSlots((current) => (current[view] === (element ?? undefined) ? current : { ...current, [view]: element ?? undefined }));
	}, []);
	const value = useMemo(() => ({ rail, slots, register }), [rail, slots, register]);
	return <Slots.Provider value={value}>{children}</Slots.Provider>;
}

/**
 * Where `view` draws its sidebar, or null when it is to draw everything in its own page.
 *
 * Reads only the registry, not the layout: a view rendered on its own — a test, anywhere outside the
 * workspace shell — has neither, and is then simply a page with everything in it.
 */
export function useNavSlot(view: SlotView): HTMLElement | null {
	const registry = useContext(Slots);
	return registry?.rail ? (registry.slots[view] ?? null) : null;
}

/** `children` in `view`'s sidebar, when it has one; nothing otherwise. */
export function NavSlot({ view, children }: { view: SlotView; children: React.ReactNode }) {
	const slot = useNavSlot(view);
	return slot ? createPortal(children, slot) : null;
}

/**
 * The sidebar's contents: the conversation list, or the slot of the view on screen.
 *
 * The conversation list is put away the way the workspace is (see `Workspace` in `App.tsx`) —
 * invisible and out of the flow but still laid out — so coming back finds it scrolled
 * and tabbed exactly as it was left. Unmounting it cost both.
 */
export function NavSlotHost({ view, children }: { view: string; children: React.ReactNode }) {
	const { rail } = useLayout();
	const registry = useContext(Slots);
	const register = registry?.register;
	// One stable ref per slot: an inline one is a new function every render, and React answers a new
	// ref with null and then the element — two registrations, two renders, and round again.
	const refs = useMemo(
		() => Object.fromEntries(SLOT_VIEWS.map((slot) => [slot, (element: HTMLElement | null) => register?.(slot, element)])) as Record<SlotView, (element: HTMLElement | null) => void>,
		[register],
	);
	const own = rail && (SLOT_VIEWS as readonly string[]).includes(view);
	return (
		<div className="relative h-full w-full">
			<div inert={own} className={own ? "pointer-events-none invisible absolute inset-0" : "h-full w-full"}>
				{children}
			</div>
			{SLOT_VIEWS.map((slot) => (
				<div key={slot} ref={refs[slot]} data-ly-nav-slot={slot} className={own && view === slot ? "ly-sidebar-fill ly-enter flex h-full w-full flex-col" : "hidden"} />
			))}
		</div>
	);
}

/** A slot's title row, level with the conversation list's 「Plume」 and spaced as it is — see `SidebarHead`. */
export function NavSlotHead({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<div className="ly-sidebar-head mt-2 flex h-[34px] shrink-0 items-center justify-between gap-2 pr-2 pl-5">
			<span className="truncate text-title font-semibold tracking-tight text-ink">{title}</span>
			{children && <div className="flex shrink-0 items-center">{children}</div>}
		</div>
	);
}

/** A row in a slot, drawn like the conversation list's 新对话 — see `NavItem`. */
export function NavSlotRow({
	icon,
	label,
	trailing,
	active,
	muted,
	onClick,
	...rest
}: {
	icon?: React.ReactNode;
	label: React.ReactNode;
	/** At the far end: a count, a status. */
	trailing?: React.ReactNode;
	/** Leads somewhere and is where you are. Absent on rows that do something rather than lead anywhere. */
	active?: boolean;
	/** Drawn fainter: there, but switched off. */
	muted?: boolean;
	onClick: () => void;
} & Record<`data-${string}`, string | undefined>) {
	return (
		<button
			type="button"
			{...rest}
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={`flex h-[32px] w-full shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-label transition-colors ${
				active ? "bg-card-hover text-ink" : `hover:bg-card-hover ${muted ? "text-ink-faint" : "text-ink"}`
			}`}
		>
			{icon && <span className="shrink-0">{icon}</span>}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{trailing}
		</button>
	);
}

/** A small heading between groups of rows. */
export function NavSlotHeading({ children }: { children: React.ReactNode }) {
	return <div className="px-2.5 pt-4 pb-1 text-detail text-ink-faint">{children}</div>;
}
