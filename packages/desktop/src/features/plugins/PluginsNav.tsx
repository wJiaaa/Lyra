/**
 * The market's sidebar: which kind of bundle, then which shelf.
 *
 * The same two choices the page's tab strip and chips make when there is no sidebar to hold them —
 * kind first, because it decides which categories exist.
 */

import { BookOpen, Blocks, LayoutGrid, Server } from "lucide-react";

import { NavSlotHead, NavSlotHeading, NavSlotRow } from "../../app/nav-slot.tsx";
import { useI18n } from "../../i18n/index.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { UNFILED } from "./useCatalog.ts";

export type Kind = "all" | "plugin" | "mcp" | "skill";

export function PluginsNav({
	kind,
	counts,
	onKind,
	categories,
	category,
	onCategory,
}: {
	kind: Kind;
	counts: Record<Kind, number>;
	onKind: (kind: Kind) => void;
	categories: { name: string; count: number }[];
	category: string | null;
	onCategory: (category: string | null) => void;
}) {
	const { t } = useI18n();
	const kinds: { id: Kind; label: string; icon: React.ReactNode }[] = [
		{ id: "all", label: t("market.all"), icon: <LayoutGrid size={16} strokeWidth={1.8} /> },
		{ id: "plugin", label: t("common.plugins"), icon: <Blocks size={16} strokeWidth={1.8} /> },
		{ id: "mcp", label: "MCP", icon: <Server size={16} strokeWidth={1.8} /> },
		{ id: "skill", label: t("common.skills"), icon: <BookOpen size={16} strokeWidth={1.8} /> },
	];
	const count = (n: number) => <span className="shrink-0 text-detail text-ink-faint tabular-nums">{n}</span>;
	return (
		<>
			<NavSlotHead title={t("market.title")} />
			<Scroller className="flex-1" contentClassName="flex flex-col gap-[2px] px-2.5 pt-1 pb-2">
				{kinds.map((entry) => (
					<NavSlotRow
						key={entry.id}
						data-market-kind={entry.id}
						icon={entry.icon}
						label={entry.label}
						active={kind === entry.id}
						trailing={count(counts[entry.id])}
						onClick={() => onKind(entry.id)}
					/>
				))}
				{categories.length > 1 && (
					<>
						<NavSlotHeading>{t("pluginDetail.category")}</NavSlotHeading>
						<NavSlotRow data-market-category="" label={t("market.allCategories")} active={category === null} onClick={() => onCategory(null)} />
						{categories.map((entry) => (
							<NavSlotRow
								key={entry.name}
								data-market-category={entry.name}
								label={entry.name === UNFILED ? t("common.other") : entry.name}
								active={category === entry.name}
								trailing={count(entry.count)}
								onClick={() => onCategory(entry.name)}
							/>
						))}
					</>
				)}
			</Scroller>
		</>
	);
}
