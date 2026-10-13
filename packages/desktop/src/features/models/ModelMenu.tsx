import { Box, ChevronRight, Star } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isImageModel } from "@plume/core/image-models";
import { ModelIcon } from "./ModelIcon.tsx";
import { ModelRail, type RailPick } from "./ModelRail.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { MenuBody, MenuItem, MenuSearch, MenuSeparator, Popover, type Anchor } from "../../ui/overlay/Popover.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { useScopedFromMessages, useScopedMeta, useScopedSessionId } from "../../app/session-scope.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import {
	ambiguousNames,
	favouriteRows,
	filterGroups,
	filterHouse,
	flattenGroups,
	groupModels,
	housesOf,
	toggleFavourite,
	type ModelRow,
} from "../../lib/model-grouping.ts";

export function formatWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

/** How many rows the number keys reach, counting through the sections in drawing order. */
const SHORTCUTS = 4;

/**
 * How tall this menu may get.
 *
 * Deliberately its own number rather than the shared `MENU_MAX_HEIGHT`: beside the rail of houses,
 * 340 under a search field cut the rail off after the eighth mark and left the list a slot. This
 * holds a rail of eleven and about eleven rows.
 */
const MODEL_MENU_MAX_HEIGHT = 420;

/**
 * Wider once the rail of houses takes its 44px: the list beside it keeps about what it had at
 * `wide`, plus the room names were already short of — `claude-sonnet-4-5-20250929` and its
 * neighbour differ only in the part that used to fade out.
 */
const MODEL_MENU_RAIL_WIDTH = 380;

/**
 * Past this the list is something you search rather than something you read, and the field earns
 * the 36px it costs. Below it, a search box over six rows is furniture.
 */
const SEARCH_FROM = 8;

/**
 * Which provider groups are folded shut, remembered across launches.
 *
 * In `localStorage` rather than in settings: it is about what this window shows, like a sidebar
 * width, not about how the app runs.
 */
const COLLAPSED_KEY = "plume.modelMenu.collapsed";

function storedCollapsed(): string[] {
	try {
		const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
		return Array.isArray(raw) ? raw.filter((each): each is string => typeof each === "string") : [];
	} catch {
		return [];
	}
}

/** One drawn block: the starred shortlist, or one provider. */
interface Section {
	key: string;
	title: string;
	rows: ModelRow[];
	/** The shortlist is not foldable — it is already the short version. */
	foldable: boolean;
}

export interface ModelSelection {
	value: string;
	onChange: (modelId: string) => void;
	inheritLabel: string;
	inheritDetail?: string;
	/** Which models are offered: conversation models (the default), or the ones that draw. */
	kind?: "chat" | "image";
}

export function ModelMenu({ anchor, onClose, selection }: { anchor: Anchor; onClose: () => void; selection?: ModelSelection }) {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	/*
	 * The conversation of the screen whose composer opened this.
	 *
	 * The live slot's `meta` is the focused screen's. Read from there, a menu opened by keyboard
	 * under the screen beside it ticked the focused conversation's model — and choosing one switched
	 * that conversation, which is why every change below names this one.
	 */
	const sessionId = useScopedSessionId();
	const meta = useScopedMeta();
	// Whether anything has been said, not the list: the menu need not redraw for every streamed token.
	const said = useScopedFromMessages((messages) => messages.length > 0);
	const setModel = useApp((s) => s.setModel);
	const confirmer = useConfirmer();
	const saveSettings = useApp((s) => s.saveSettings);
	const setView = useApp((s) => s.setView);
	const setSection = useApp((s) => s.setSettingsSection);
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [collapsed, setCollapsed] = useState<string[]>(storedCollapsed);
	const [pick, setPick] = useState<RailPick>("all");
	/** The row arrows move and Enter takes — one highlight shared with the pointer, as in the command palette. */
	const [active, setActive] = useState(0);
	/** Set by an arrow key, so only the keyboard scrolls the highlight into view; a hover must not pull rows. */
	const keyed = useRef(false);
	/*
	 * Where the pointer last really moved. Chromium fires a `mousemove` without any movement when
	 * the list scrolls under a resting pointer — after an arrow key brings a row into view, say —
	 * and taken at face value it handed the highlight to whatever row had just slid under it.
	 */
	const pointer = useRef({ x: -1, y: -1 });
	const hover = (index: number, event: React.MouseEvent) => {
		if (event.clientX === pointer.current.x && event.clientY === pointer.current.y) return;
		pointer.current = { x: event.clientX, y: event.clientY };
		setActive(index);
	};

	const current = selection ? selection.value : meta?.modelId ?? settings?.defaultModelId ?? null;
	const favourites = settings?.favoriteModelIds;
	const kind = selection?.kind ?? "chat";
	const groups = useMemo(() => groupModels(settings?.providers, kind), [settings?.providers, kind]);
	/*
	 * Which names need their house said out loud.
	 *
	 * Computed over every group rather than the filtered ones: a search that happens to narrow to
	 * one of two identical names would otherwise drop the very mark that tells them apart.
	 */
	const clashes = useMemo(() => ambiguousNames(groups), [groups]);
	const total = useMemo(() => flattenGroups(groups).length, [groups]);
	/*
	 * Whether this list is long enough to be searched, which decides who owns the number keys.
	 *
	 * They cannot both have them. A search field takes focus the moment the menu opens, and model
	 * names are mostly version numbers — `claude-opus-4`, `gemini-3.7`, `grok-4.6` — so typing a
	 * digit is an ordinary way to start looking for one. While the shortcut also claimed them, the
	 * first digit of a query picked the model on that row and shut the menu, which does not make
	 * searching awkward so much as impossible: you never get to the second character.
	 *
	 * So the field wins wherever there is a field, and the digits are not drawn on the rows when
	 * they are not there to be pressed. A shortcut you cannot use is worse than no shortcut: it is
	 * the menu telling you about a key that does something else entirely.
	 */
	const searchable = total >= SEARCH_FROM;

	/*
	 * The rail, where there is a choice of house to make: a long list from one maker is narrowed by
	 * searching, and a rail holding one mark would only repeat the heading beside it.
	 */
	const houses = useMemo(() => housesOf(groups), [groups]);
	const hasStarred = useMemo(() => favouriteRows(groups, favourites).length > 0, [groups, favourites]);
	const railed = searchable && houses.length >= 2;
	// A pick that stopped existing — the last star taken off, a provider switched off — falls back to everything.
	const view: RailPick =
		!railed || (pick === "favourites" ? !hasStarred : pick !== "all" && !houses.includes(pick)) ? "all" : pick;
	const shown = useMemo(
		() => filterGroups(view === "all" || view === "favourites" ? groups : filterHouse(groups, view), query),
		[groups, view, query],
	);

	/*
	 * The shortlist, then the houses.
	 *
	 * Starred models are drawn twice on purpose — once at the top and once under the provider they
	 * belong to. Removing them from their group would make a group's count wrong and move rows
	 * around as you star things, which is the opposite of what a shortlist is for.
	 */
	const sections = useMemo<Section[]>(() => {
		const shortlist = (rows: ModelRow[]): Section[] =>
			rows.length > 0 ? [{ key: "__favourites__", title: t("modelMenu.favourite"), rows, foldable: false }] : [];
		// On its own tab the shortlist is the whole list, so a query narrows it rather than hiding it.
		if (view === "favourites") return shortlist(favouriteRows(shown, favourites));
		const starred = query || view !== "all" ? [] : favouriteRows(groups, favourites);
		return [
			...shortlist(starred),
			...shown.map((group) => ({
				key: group.provider.id,
				title: group.provider.name,
				rows: group.models.map((model) => ({ provider: group.provider, model })),
				foldable: true,
			})),
		];
	}, [groups, favourites, shown, query, view, t]);

	const opened = (section: Section) => !section.foldable || Boolean(query) || !collapsed.includes(section.key);

	/** The rows a number key or an arrow can reach: what is on screen, in the order it is drawn. */
	const reachable = sections.filter(opened).flatMap((section) => section.rows);
	/** Where each open section's rows begin in `reachable`, so a starred model drawn twice is two positions. */
	const starts = new Map<string, number>();
	sections.filter(opened).reduce((offset, section) => (starts.set(section.key, offset), offset + section.rows.length), 0);

	const at = Math.min(active, reachable.length - 1);

	useLayoutEffect(() => {
		if (!keyed.current) return;
		keyed.current = false;
		document.querySelector('[data-model][data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [at]);

	/*
	 * A switch that does not go through has to say so.
	 *
	 * `setModel` paints the new model first and rolls back if the write fails, so a silent rejection
	 * leaves the composer showing the model it went back to — which is indistinguishable from never
	 * having pressed anything. It was `void`ed here, so the rejection was an unhandled one in the
	 * console and nothing else.
	 */
	const apply = (modelId: string) => {
		void setModel(modelId, { sessionId }).catch((cause: unknown) => {
			useApp
				.getState()
				.notify(t("modelMenu.switchFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
		});
	};

	const choose = (modelId: string) => {
		if (selection) {
			selection.onChange(modelId);
			onClose();
			return;
		}
		const midConversation = said && current !== modelId;
		if (midConversation) {
			confirmer.ask({
				title: t("modelMenu.midConfirm"),
				detail: (
					<>
						{t("modelMenu.midDetail1")}
						<br />
						{t("modelMenu.midDetail2")}
						<br />
						{t("modelMenu.midDetail3")}
						<br />
						{t("modelMenu.midDetail4")}
					</>
				),
				confirmLabel: t("modelMenu.confirmSwitch"),
				cancelLabel: t("common.cancel"),
				tone: "danger",
				onConfirm: () => {
					apply(modelId);
					onClose();
				},
			});
			return;
		}
		apply(modelId);
		onClose();
	};

	const fold = useCallback((key: string) => {
		setCollapsed((current) => {
			const next = current.includes(key) ? current.filter((each) => each !== key) : [...current, key];
			try {
				window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
			} catch {
				/* A preference that cannot be stored is still a preference for this session. */
			}
			return next;
		});
	}, []);

	const star = useCallback(
		(id: string) => {
			const latest = useApp.getState().settings;
			if (!latest) return;
			setError("");
			void saveSettings({ ...latest, favoriteModelIds: toggleFavourite(latest.favoriteModelIds, id) })
				.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
		},
		[saveSettings],
	);

	/*
	 * Arrows and Enter from the search field, which keeps focus throughout: type a few letters and
	 * Enter takes the top match, which is most of what finding a model in a long list should cost.
	 */
	const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (reachable.length === 0) return;
			event.preventDefault();
			keyed.current = true;
			setActive((at + (event.key === "ArrowDown" ? 1 : reachable.length - 1)) % reachable.length);
			return;
		}
		// Not while an input method is still composing: that Enter commits the characters, not a model.
		if (event.key === "Enter" && !event.nativeEvent.isComposing && reachable[at]) {
			event.preventDefault();
			choose(reachable[at].model.id);
		}
	};

	// Number keys pick from the first rows, matching the digits drawn on them.
	useEffect(() => {
		// A searchable list has given the digits to the field; see `searchable`.
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			/*
			 * Anything being typed into owns what is typed into it.
			 *
			 * This used to read 「is the query non-empty」, which is a different question and false for
			 * the first character of every query — the field opens focused and empty, so the 「4」 of
			 * `claude-opus-4` picked the model on row four and shut the menu before a second character
			 * could be typed. `searchable` above is what settles the general case; this stays as the
			 * rule it was always meant to be, and covers any field a menu grows later.
			 */
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
			)
				return;
			const index = Number(event.key) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= Math.min(SHORTCUTS, reachable.length)) return;
			event.preventDefault();
			choose(reachable[index].model.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<>
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement={selection ? "bottom" : "top"}
			align={selection ? "end" : "start"}
			width={railed ? MODEL_MENU_RAIL_WIDTH : "wide"}
			label={t("modelMenu.pick")}
			/*
			 * A list long enough to search keeps one height while it is filtered.
			 *
			 * Opened upwards the card is pinned by its bottom edge, so a list that shrank as you
			 * typed pulled the field you were typing into — and the rail beside it — down the screen
			 * under the pointer. At eight models and up the natural height is at the ceiling anyway.
			 */
			className={searchable ? "h-[420px]" : ""}
			aside={
				railed ? (
					<ModelRail
						houses={houses}
						favourites={hasStarred}
						value={view}
						onChange={(next) => {
							setPick(next);
							setActive(0);
						}}
					/>
				) : undefined
			}
			/*
			 * A ceiling, so a relay with thirty models does not draw a menu from the composer to the
			 * top of the screen. The body scrolls inside it; the search field above stays put.
			 */
			maxHeight={MODEL_MENU_MAX_HEIGHT}
			header={
				searchable ? (
					<MenuSearch
						value={query}
						onChange={(next) => {
							setQuery(next);
							setActive(0);
						}}
						onKeyDown={onSearchKey}
						placeholder={t("modelMenu.search")}
					/>
				) : undefined
			}
		>
			<MenuBody>
				{error && <p role="alert" className="px-2 py-1 text-detail text-danger">{error}</p>}
				{/* Filled, not ticked, like the model rows under it: it is one of the choices in this
				    list, and a list that marks its rows two ways is a list you have to read twice. */}
				{selection && !query && view === "all" && <>
					<MenuItem icon={<Box size={14} />} selected={!current} className="ly-model-row"
						detail={selection.inheritDetail ? <ScrollText text={selection.inheritDetail} /> : undefined}
						onClick={() => choose("")}>{selection.inheritLabel}</MenuItem>
					<MenuSeparator />
				</>}
				{total === 0 && (
					<MenuItem
						onClick={() => {
							setView("settings");
							setSection("models");
							onClose();
						}}
					>
						{t("modelMenu.noModels")}
					</MenuItem>
				)}

				{total > 0 && sections.length === 0 && (
					<p className="px-2 py-6 text-center text-detail text-ink-faint">{t("modelMenu.noMatch")}</p>
				)}

				{sections.map((section) => {
					const folded = !opened(section);
					return (
						<div key={section.key}>
							<SectionHead
								title={section.title}
								count={section.rows.length}
								folded={folded}
								foldable={section.foldable}
								onFold={() => fold(section.key)}
							/>

							{/* A hair of air between rows, so a filled one reads as a card of its own
							    rather than as a stripe painted across a solid block of list. */}
							{!folded && (
								<div className="flex flex-col gap-0.5">
									{section.rows.map((row, i) => {
										const index = (starts.get(section.key) ?? 0) + i;
										return (
											<ModelItem
												key={`${section.key}:${row.model.id}`}
												row={row}
												selected={current === row.model.id}
												starred={Boolean(favourites?.includes(row.model.id))}
												// Two houses offering one name: say which, on both rows.
												showProvider={clashes.has(row.model.name.trim().toLowerCase())}
												// Drawn only where the key it names actually does this; see `searchable`.
												numbered={!searchable && !query}
												shortcut={index < SHORTCUTS ? index + 1 : null}
												// Only where a key can act on it; see `onSearchKey`.
												active={searchable ? index === at : undefined}
												onHover={(event) => hover(index, event)}
												onChoose={() => choose(row.model.id)}
												onStar={() => star(row.model.id)}
											/>
										);
									})}
								</div>
							)}
						</div>
					);
				})}

			</MenuBody>
		</Popover>
		{confirmer.element}
		</>
	);
}

/**
 * A group's heading, which is also its fold.
 *
 * The count stays visible while folded — that is the only thing a shut group can say about
 * itself — and the chevron is the only mark that moves, so the row reads the same open or shut.
 */
function SectionHead({
	title,
	count,
	folded,
	foldable,
	onFold,
}: {
	title: string;
	count: number;
	folded: boolean;
	foldable: boolean;
	onFold: () => void;
}) {
	if (!foldable) {
		return (
			<div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-caption text-ink-faint">
				<Star size={10} strokeWidth={2} className="fill-current" />
				{title}
				<span className="text-ink-faint/70">{count}</span>
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-expanded={!folded}
			onClick={onFold}
			className="ly-item flex w-full items-center gap-1.5 px-2 py-1 text-caption text-ink-faint hover:text-ink-muted"
		>
			<ChevronRight
				size={11}
				strokeWidth={2.4}
				className={`shrink-0 transition-transform duration-[var(--ly-t-quick)] ${folded ? "" : "rotate-90"}`}
			/>
			<span className="min-w-0 flex-1 truncate text-left">{title}</span>
			<span className="shrink-0 tabular-nums">{count}</span>
		</button>
	);
}

/**
 * One model.
 *
 * A row rather than a `MenuItem` because it holds two targets: choosing the model, and starring
 * it. A star inside the row's own button would be a button inside a button — invalid markup, and
 * a click that fires both handlers. So the fill belongs to the row and the two controls sit in it,
 * the same arrangement the session rows in the sidebar use.
 */
function ModelItem({
	row,
	selected,
	starred,
	showProvider,
	numbered,
	shortcut,
	active,
	onHover,
	onChoose,
	onStar,
}: {
	row: ModelRow;
	selected: boolean;
	starred: boolean;
	showProvider: boolean;
	/**
	 * Whether this menu is handing out number keys at all, which is a fact about the menu and not
	 * about this row — so the column is reserved on every row or on none of them.
	 *
	 * Per-row would put the window of the fifth model 13px right of the window of the fourth, and
	 * a column that only lines up for the first four rows reads as a mistake rather than as a
	 * shortcut. In a list long enough to be searched there are no digits anywhere, and the column
	 * is not drawn — which is what lets the window sit at the edge it is measured from.
	 */
	numbered: boolean;
	shortcut: number | null;
	/**
	 * Whether arrows and Enter are on this row. Left undefined in a list with no search field,
	 * where no key acts on a highlight and drawing one would promise something.
	 */
	active: boolean | undefined;
	onHover: (event: React.MouseEvent) => void;
	onChoose: () => void;
	onStar: () => void;
}) {
	const { t } = useI18n();
	const { model, provider } = row;

	return (
		/*
		 * `data-model` is the handle the end-to-end tests aim at, the same way session rows carry
		 * `data-ly-row`: a menu row is otherwise indistinguishable from the switches below it.
		 *
		 * `ly-scroll` is what makes the name read itself out on hover. The `ScrollText` below has
		 * always been able to — it measures its own overflow and lays out the second copy that makes
		 * the loop seamless — but the animation is keyed off a hovered ancestor carrying this class,
		 * and this row never carried it. So every name too long for the row simply sat there faded
		 * at the edge, with no way to see the rest of it: `claude-opus-4-…` and `claude-opus-4-…`
		 * being two different models you could not tell apart.
		 */
		<div
			data-model={model.id}
			data-selected={selected ? "true" : undefined}
			data-nav={active === undefined ? undefined : ""}
			data-active={active ? "true" : undefined}
			onMouseMove={active === undefined ? undefined : onHover}
			className="ly-scroll ly-item ly-model-row flex h-[var(--ly-menu-row)] items-center"
		>
			<button
				type="button"
				role="menuitem"
				onClick={onChoose}
				className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-3 pr-1 text-left text-label"
			>
				{/* The house, not the provider: one relay serves models from five of them, so a
				    provider icon here would draw the same mark on every row. */}
				<span className="flex w-[18px] shrink-0 items-center justify-center">
					<ModelIcon model={model.modelId} name={model.name} size={14} />
				</span>
				<span className="min-w-0 flex-1">
					<ScrollText text={showProvider ? `${model.name} · ${provider.name}` : model.name} />
				</span>
			</button>

			{/*
			 * The digits, where there are digits; see `numbered`.
			 *
			 * It used to share this column with the checkmark, which is why the checkmark is gone
			 * rather than moved: the selected row now says so with a fill, and nothing is left that
			 * needs a column of its own.
			 */}
			{numbered && (
				<span className="flex h-full w-[13px] shrink-0 items-center justify-center font-mono text-caption text-ink-faint">
					{shortcut}
				</span>
			)}

			{/*
			 * One column, two things, taking turns: how much context the model holds, and whether
			 * you have starred it.
			 *
			 * They were side by side, and that was two columns charged to every row for two facts
			 * you never need at the same moment — the window is what you read while choosing, and
			 * the star is what you reach for once you have chosen. Worse, a starred row paid for
			 * its star permanently: the lit star sat there on every favourite, on the shortlist
			 * that already says they are favourites, so the mark was drawn twice and told you
			 * nothing the heading had not.
			 *
			 * So the window holds the column at rest, and the pointer trades it for the star. The
			 * width is whatever the window needs — the star is absolutely placed over it and
			 * cannot change it — which is what keeps every row's right edge on one line while
			 * 「1M」 and 「200K」 are different lengths.
			 */}
			{/* `pl-2.5` is the gap the name used to get from the row's own `gap-2.5`, back again now
			    that the window has moved out of the button: without it 「claude-opus-4-2025」 and
			    「200K」 run together into one word at the point where the name fades out. */}
			<span className="relative flex h-full shrink-0 items-center justify-end pl-2.5 pr-3 text-caption">
				<span className="ly-model-window font-mono text-ink-faint">
					{/* A context window means nothing for a model that draws; the column stays for alignment. */}
					{isImageModel(model) ? "" : formatWindow(model.contextWindow)}
				</span>
				<button
					type="button"
					aria-label={starred ? t("modelMenu.unfavouriteOne", { name: model.name }) : t("modelMenu.favouriteOne", { name: model.name })}
					aria-pressed={starred}
					data-ly-tip={starred ? t("modelMenu.unfavourite") : t("modelMenu.favourite")}
					onClick={onStar}
					className={`ly-model-star absolute inset-0 flex items-center justify-end pr-3 ${
						starred ? "text-accent" : "text-ink-faint hover:text-ink"
					}`}
				>
					<Star size={12.5} strokeWidth={1.9} className={starred ? "fill-current" : ""} />
				</button>
			</span>
		</div>
	);
}
