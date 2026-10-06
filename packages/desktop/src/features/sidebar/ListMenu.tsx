/**
 * How the list is ordered, and how much of it is open.
 *
 * A menu rather than more controls in the strip. Sorting and folding are settings you change now
 * and then and read never — a permanent control for each would put three more targets in a column
 * whose whole problem is that conversations start too far down it.
 *
 * Ordering applies to the project list and the flat list search shows alike: they are arrangements
 * of the same conversations, and a list sorted one way in one of them and another way
 * in the other is two different answers to the same question.
 */

import { ArrowUpDown, CalendarPlus, ChevronsDownUp, ChevronsUpDown, Clock, Check } from "lucide-react";
import { MenuBody, MenuItem, MenuLabel, MenuSeparator, Popover, type Anchor } from "../../ui/overlay/Popover.tsx";
import type { SessionSortKey } from "../../lib/sidebar-order.ts";
import { useI18n, type MessageKey } from "../../i18n/index.ts";

/** Which timestamp orders the list, and bands it. */
export type SortKey = SessionSortKey;

const SORTS: { value: SortKey; labelKey: MessageKey; icon: React.ReactNode }[] = [
	{ value: "updatedAt", labelKey: "sidebar.updated", icon: <Clock size={14} strokeWidth={1.8} /> },
	{ value: "createdAt", labelKey: "sidebar.created", icon: <CalendarPlus size={14} strokeWidth={1.8} /> },
];

export function ListMenu({
	anchor,
	sort,
	hasManual,
	onSort,
	canFold,
	allFolded,
	onFoldAll,
	onClose,
}: {
	anchor: Anchor;
	sort: SortKey;
	hasManual?: boolean;
	onSort: (sort: SortKey) => void;
	/** Whether there is any project to fold. */
	canFold: boolean;
	/** Whether every project is currently shut, which is what makes this one control and not two. */
	allFolded: boolean;
	onFoldAll: (folded: boolean) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" width="compact" label={t("sidebar.listSettings")}>
			<MenuBody insetIcons>
				<MenuLabel>{t("sidebar.sortBy")}</MenuLabel>
				{[
					...SORTS,
					...(hasManual || sort === "manual"
						? [{ value: "manual" as const, labelKey: "sidebar.manual" as const, icon: <ArrowUpDown size={14} strokeWidth={1.8} /> }]
						: []),
				].map((option) => (
					<MenuItem
						key={option.value}
						icon={option.icon}
						selected={sort === option.value}
						trailing={sort === option.value ? <Check size={13} strokeWidth={2.2} /> : undefined}
						onClick={() => {
							onSort(option.value);
							onClose();
						}}
					>
						{t(option.labelKey)}
					</MenuItem>
				))}

				{/*
				 * Only with projects in the list, because otherwise there is nothing to fold.
				 *
				 * A row that is present but does nothing is worse than one that is absent: it says
				 * the feature is missing rather than inapplicable, and the only way to find out
				 * which is to press it.
				 */}
				{canFold && (
					<>
						<MenuSeparator />
						<MenuItem
							icon={
								allFolded ? (
									<ChevronsUpDown size={14} strokeWidth={1.8} />
								) : (
									<ChevronsDownUp size={14} strokeWidth={1.8} />
								)
							}
							onClick={() => {
								onFoldAll(!allFolded);
								onClose();
							}}
						>
							{allFolded ? t("sidebar.expandProjects") : t("sidebar.collapseProjects")}
						</MenuItem>
					</>
				)}
			</MenuBody>
		</Popover>
	);
}
