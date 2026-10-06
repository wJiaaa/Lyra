/**
 * The navigation pane: what you can go to, and what you have been in.
 *
 * One list: the projects, and under 「最近」 the conversations that belong to none
 * (`sidebar/ProjectList`). Searching swaps it for every match in one flat run banded by date
 * (`sidebar/ChatList`), because matches scattered five rows down across a dozen projects is the
 * scrolling a search exists to end. The current heading is held at the top by `position: sticky`;
 * the only part of that JavaScript owns is where the fade below it starts, which is
 * `sidebar/useStickyFade` and `sidebar/sticky.ts`. The archive is not here: it is 设置 › 已归档的聊天.
 *
 * Only the pane itself is here. Which conversations are listed and what a row does is
 * `sidebar/useSidebarLists`; the rules underneath it are `lib/sidebar-grouping` and `sidebar/recency`.
 */

import { ListFilter, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLayout } from "../../app/layout.tsx";
import { useApp } from "../../store/index.ts";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { ChatList, CHAT_PAGE } from "./ChatList.tsx";
import { DestinationNav } from "./DestinationNav.tsx";
import { ListMenu, type SortKey } from "./ListMenu.tsx";
import { NavItem } from "./NavItem.tsx";
import { SESSION_PAGE } from "./ProjectGroup.tsx";
import { ProjectList } from "./ProjectList.tsx";
import { SidebarFoot } from "./SidebarFoot.tsx";
import { SidebarHead } from "./SidebarHead.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { SessionCarryGhost } from "../split/index.ts";
import { PhoneDock } from "./PhoneDock.tsx";
import { useSidebarLists } from "./useSidebarLists.ts";
import { onPhone } from "../../services/index.ts";
import { useStickyFade } from "./useStickyFade.ts";
import { useI18n } from "../../i18n/index.ts";

/** Where the folded-project list is remembered. */
const COLLAPSED_KEY = "ly-collapsed-projects";
/** And what "most recent" means, which is a preference rather than a place. */
const SORT_KEY = "ly-sidebar-sort";

export function Sidebar() {
	const { t } = useI18n();
	const scratchRoots = useApp((s) => s.scratchRoots);
	const newSession = useApp((s) => s.newSession);
	/**
	 * As a drawer this pane covers the thing it navigates to, so anything that changes what is
	 * behind it also has to get out of the way. Pushed, `dismissNav` does nothing and the
	 * sidebar stays where the user put it.
	 */
	const { compact, headerBar, framed, rail: railShown, dismissNav } = useLayout();
	/*
	 * On a phone the pane is a drawer held in one hand, and its controls move to where the thumb is:
	 * search, 新对话 and settings leave the top and the footer for `PhoneDock` along the bottom edge.
	 * Everything they do is unchanged — they are the same three calls, lower down.
	 */
	const phone = onPhone();

	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	/** How many rows each project is showing. Absent means the default five. */
	const [shown, setShown] = useState<Record<string, number>>({});
	/** The same, for the 「最近」 section — one number, because there is only ever one of it. */
	const [looseShown, setLooseShown] = useState(SESSION_PAGE);
	/** And for the flat list search shows. */
	const [chatShown, setChatShown] = useState(CHAT_PAGE);
	/** Which timestamp orders the list and search results. Persisted: it is a preference, not a mode. */
	const [sort, setSort] = useState<SortKey>(() => {
		const val = localStorage.getItem(SORT_KEY);
		return val === "updatedAt" ? "updatedAt" : val === "manual" ? "manual" : "createdAt";
	});
	// Stable, so the reorder hook's window listeners are not re-registered on every render.
	const markManual = useCallback(() => setSort("manual"), []);
	const hasManual = useApp((state) => Object.keys(state.settings?.sessionOrder ?? {}).length > 0);
	const menu = usePopover();
	/**
	 * Which projects are folded shut.
	 *
	 * Kept here rather than in each group: a group is rebuilt whenever the session list changes,
	 * and state living inside one would unfold every time somebody sent a message. Persisted, so a
	 * sidebar somebody tidied stays tidy across launches.
	 */
	const [collapsed, setCollapsed] = useState<string[]>(() => {
		try {
			const stored = localStorage.getItem(COLLAPSED_KEY);
			return stored ? (JSON.parse(stored) as string[]) : [];
		} catch {
			return [];
		}
	});
	const toggleCollapsed = (path: string) =>
		setCollapsed((current) => (current.includes(path) ? current.filter((p) => p !== path) : [...current, path]));

	/*
	 * Written here rather than inside the updater above.
	 *
	 * An updater has to be a pure function of its argument, because React calls it more than once —
	 * twice per commit under StrictMode, and again whenever it replays a render it threw away.
	 * Writing to storage in there meant the last write was not necessarily the one matching the
	 * state that survived: folding a project left the fold on screen and `[]` on disk, so it came
	 * back open on the next launch. The effect runs once per committed value, which is the only
	 * moment a persisted copy is meaningful.
	 */
	useEffect(() => {
		try {
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
			localStorage.setItem(SORT_KEY, sort);
		} catch {
			// A full or disabled storage costs the memory of the choice, not the choice itself.
		}
	}, [collapsed, sort]);

	const viewport = useRef<HTMLDivElement>(null);
	/*
	 * Opening or closing the search starts the new list at its own top — the *list's* top, not the
	 * pane's.
	 *
	 * A depth into one list means nothing in another: without this, a shorter list lands you in its
	 * middle or past its end. But zero is further up than the list begins when the destinations sit
	 * above it in the same scroller (a drawer, no icon rail), and they did not change — going to zero
	 * threw them back on screen. Only ever upwards; the browser's own clamp handles the rest.
	 *
	 * Measured off the element above the list, not the list: the list is mid-entrance (`ly-enter`)
	 * and its box still carries the animation's offset.
	 */
	useEffect(() => {
		const view = viewport.current;
		if (!view) return;
		const above = view.querySelector<HTMLElement>("[data-ly-list]")?.previousElementSibling;
		const anchor = above
			? Math.max(0, view.scrollTop + above.getBoundingClientRect().bottom - view.getBoundingClientRect().top)
			: 0;
		if (view.scrollTop > anchor) view.scrollTop = anchor;
	}, [searching]);

	// Headings rest against the top edge: nothing is held above them any more.
	useStickyFade(viewport, 0, 0);

	const { groups, matching, bands, actions } = useSidebarLists({
		query,
		sort,
		chatShown,
		onOpened: dismissNav,
	});

	/*
	 * Folding everything at once, which is one control rather than two.
	 *
	 * "All shut" is the only state where the reverse is the useful offer, and it is a state you can
	 * see — so the menu asks the question the list is already answering rather than listing both
	 * directions and making you work out which one applies.
	 */
	const foldable = groups.projects.map((group) => group.path);
	const allFolded = foldable.length > 0 && foldable.every((path) => collapsed.includes(path));
	const foldAll = (folded: boolean) =>
		setCollapsed((current) =>
			folded
				? [...new Set([...current, ...foldable])]
				: current.filter((path) => !foldable.includes(path)),
		);

	/*
	 * Searching is looking for one conversation, so it shows every match in one flat run — see the
	 * top of this file. Closing the search brings the project list back.
	 */
	const toggleSearch = () => {
		if (searching) setQuery("");
		setSearching(!searching);
	};

	const pad = compact ? "px-3" : "px-2.5";
	const empty = query.trim() ? (
		<p className="px-2 py-6 text-center text-detail text-ink-faint">{t("sidebar.noMatches")}</p>
	) : (
		<p className="px-2 py-6 text-center text-detail leading-relaxed text-ink-faint">
			{t("sidebar.noSessions")}
			<br />
			{t("sidebar.newChatHint")}
		</p>
	);
	return (
		// No right border: the sidebar's own tint is what sets it apart from the column beside
		// it. A rule on top of that reads as a seam rather than a boundary.
		<div
			className="ly-sidebar-fill flex h-full w-full flex-col"
			/*
			 * Where headings come to rest: the top edge, now that no control row is held above them.
			 * Kept as a variable so the rows stay plain `sticky top-[var(--ly-rail)]` — CSS holds them,
			 * which is the only way they keep up with a wheel. See `sidebar/sticky.ts`.
			 */
			style={{ "--ly-rail": "0px" } as React.CSSProperties}
		>
			{/*
			 * 给窗口顶上那一行让出的空当。
			 *
			 * macOS 才有：红绿灯画在侧边栏的左上角，侧边栏自己的内容得从它们下面开始。Windows 和 Linux
			 * 那条 header 已经把整行占走了，侧边栏从 header 底下开始，再留一次就是 88px 的空白。
			 */}
			{/*
			 * Not in a phone's drawer: there are no traffic lights, the sidebar button stays on the page
			 * under the drawer, and the drawer's own padding keeps it clear of the status bar (see
			 * `phone.css`). Beside the conversation — a phone on its side, a tablet — the button sits
			 * in this row again, so the row stays.
			 */}
			{!headerBar && !framed && !(phone && compact) && <div className="h-[44px] shrink-0" />}

			<SidebarHead searching={searching} query={query} onQuery={setQuery} onToggleSearch={toggleSearch} />

			{/* Only 新对话 is pinned above the list — see `DestinationNav` for why the other three
			    are not. On a phone it is the round button in the dock instead. */}
			{!phone && (
				<nav className={`flex flex-col pb-1 ${pad}`}>
					<NavItem
						icon={<SquarePen size={16} />}
						label={t("sidebar.newChat")}
						onClick={() => {
							void newSession();
							dismissNav();
						}}
					/>
				</nav>
			)}

			{/*
			 * Both ends soften.
			 *
			 * This was a hairline on top and nothing at the bottom, on the reasoning that the nav
			 * above and the settings row below are solid — content passes behind them rather than
			 * dissolving into them, so a fade would leave half-lit rows hanging off an opaque block.
			 * That was true of the fade we had, which painted a strip of `--color-sidebar` over the
			 * list; on a pane whose fill is translucent that strip is a grey film with an edge of its
			 * own, and the half-lit rows were it.
			 *
			 * A mask has no such problem — the rows genuinely thin out to nothing — and once they
			 * really do, the argument turns around: a hard rule at the top of a list that runs on
			 * says the list ended there. See `.ly-fade-y`.
			 */}
			<Scroller className="flex-1" contentClassName={`pb-2 ${pad}`} scrollRef={viewport}>
				{/* In the frame these are the rail's; a drawer has no rail beside it, so they stay here. */}
				{!railShown && <DestinationNav onNavigate={dismissNav} />}

				{/*
				 * Keyed on the search, so opening or closing it replays the entrance.
				 *
				 * The two share this scroller and neither is a change to the list on screen — they are
				 * different lists. The animation is what says so; without it the rows simply
				 * become other rows, which at a glance reads as the sidebar having reordered itself.
				 *
				 * `pt-3` 是上面那截和列表之间的间距，由这里统一给，两个列表的第一个标题都不再自带上间距——
				 * 各自带的时候，项目列表比扁平列表远 16px，开关搜索时标题上下跳。
				 */}
				<div key={searching ? "flat" : "grouped"} data-ly-list className="ly-enter pt-3">
					{!searching ? (
						<ProjectList
							groups={groups}
							collapsed={collapsed}
							onToggleCollapsed={toggleCollapsed}
							groupProps={(path) => ({
								collapsed: collapsed.includes(path),
								onToggleCollapsed: () => toggleCollapsed(path),
								shown: shown[path] ?? SESSION_PAGE,
								onShowMore: () =>
									setShown((prev) => ({ ...prev, [path]: (prev[path] ?? SESSION_PAGE) + SESSION_PAGE })),
								onCollapse: () => setShown((prev) => ({ ...prev, [path]: SESSION_PAGE })),
								actions,
							})}
							looseShown={looseShown}
							onLooseMore={() => setLooseShown((n) => n + SESSION_PAGE)}
							onLooseCollapse={() => setLooseShown(SESSION_PAGE)}
							actions={actions}
							empty={empty}
							sort={sort}
							onReordered={markManual}
							listSettings={
								<IconButton
									size="sm"
									label={t("sidebar.listSettings")}
									menu={menu.open}
									onClick={menu.toggle}
									icon={<ListFilter size={13} strokeWidth={2} aria-hidden />}
								/>
							}
						/>
					) : (
						<ChatList
							bands={bands}
							scratchRoots={scratchRoots}
							hidden={Math.max(0, matching.length - chatShown)}
							canCollapse={chatShown > CHAT_PAGE}
							onShowMore={() => setChatShown((n) => n + CHAT_PAGE)}
							onCollapse={() => setChatShown(CHAT_PAGE)}
							actions={actions}
							empty={empty}
						/>
					)}
				</div>
			</Scroller>

			<SessionCarryGhost />
			{phone ? (
				<PhoneDock
					searching={searching}
					query={query}
					onQuery={setQuery}
					onToggleSearch={toggleSearch}
					onNavigate={dismissNav}
				/>
			) : (
				!railShown && <SidebarFoot onNavigate={dismissNav} />
			)}

			{menu.open && (
				<ListMenu
					anchor={menu.anchor}
					sort={sort}
					hasManual={hasManual}
					onSort={setSort}
					canFold={foldable.length > 0}
					allFolded={allFolded}
					onFoldAll={foldAll}
					onClose={menu.close}
				/>
			)}
		</div>
	);
}
