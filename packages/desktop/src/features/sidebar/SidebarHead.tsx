/**
 * The pane's title bar, and the search that drops out of it.
 *
 * The app name, and nothing more. It used to open the project picker, which put the same control
 * in two places and read as a dropdown over the whole window. Switching projects belongs on the
 * composer's project chip, next to what it actually scopes.
 */

import { Bell, Search } from "lucide-react";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { useI18n } from "../../i18n/index.ts";

export function SidebarHead({
	searching,
	query,
	onQuery,
	onToggleSearch,
}: {
	searching: boolean;
	query: string;
	onQuery: (query: string) => void;
	/** Opens the field, and — pressed again or on Escape — closes it and clears what was typed. */
	onToggleSearch: () => void;
}) {
	const { t } = useI18n();
	return (
		<>
			<div className="ly-sidebar-head flex h-[34px] shrink-0 items-center justify-between px-4">
				<span className="text-title font-semibold tracking-tight text-ink">Plume</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						data-ly-tip={t("sidebar.search")}
						aria-label={t("sidebar.search")}
						aria-pressed={searching}
						onClick={onToggleSearch}
						className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-card-hover hover:text-ink ${
							searching ? "bg-card-hover text-ink" : "text-ink-muted"
						}`}
					>
						<Search size={15} strokeWidth={1.9} />
					</button>
					<button
						type="button"
						data-ly-tip={t("sidebar.notifications")}
						aria-label={t("sidebar.notifications")}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
					>
						<Bell size={15} strokeWidth={1.9} />
					</button>
				</div>
			</div>

			{searching && (
				<div className="px-3 pb-2">
					<SearchField
						autoFocus
						size="comfortable"
						value={query}
						onChange={onQuery}
						onEscape={onToggleSearch}
						placeholder={t("sidebar.searchPlaceholder")}
					/>
				</div>
			)}
		</>
	);
}
