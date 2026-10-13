/**
 * The column of houses down the left of the model picker.
 *
 * A long list was only ever searched or scrolled, and both start from a name: you had to know how
 * a relay spelled the model before you could find it. The question people actually arrive with is
 * usually 「which Claude」, and a mark answers that before any name is read — so one press narrows
 * the list to a house, across every provider that serves it.
 */

import { Grid2x2, Star } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { brandName } from "../../lib/model-brand.ts";
import type { House } from "../../lib/model-grouping.ts";
import { ModelIcon } from "./ModelIcon.tsx";

/** What the rail can narrow to: everything, the starred shortlist, or one house. */
export type RailPick = "all" | "favourites" | House;

export function ModelRail({
	houses,
	favourites,
	value,
	onChange,
}: {
	houses: House[];
	/** Whether anything is starred; the shortlist gets a place on the rail only when it has rows. */
	favourites: boolean;
	value: RailPick;
	onChange: (pick: RailPick) => void;
}) {
	const { t } = useI18n();
	const name = (house: House) => (house === "other" ? t("modelMenu.otherHouse") : brandName(house));

	return (
		// The bar is hidden, not absent: a rail with more houses than fit still scrolls by wheel.
		<nav aria-label={t("modelMenu.houses")} className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto p-1.5 [scrollbar-width:none]">
			<RailButton label={t("modelMenu.allModels")} pressed={value === "all"} onPress={() => onChange("all")}>
				<Grid2x2 size={15} strokeWidth={1.8} />
			</RailButton>
			{favourites && (
				<RailButton label={t("modelMenu.favourite")} pressed={value === "favourites"} onPress={() => onChange("favourites")}>
					<Star size={15} strokeWidth={1.8} />
				</RailButton>
			)}
			<div aria-hidden className="my-1 h-px w-5 shrink-0 bg-line-float" />
			{houses.map((house) => (
				<RailButton key={house} label={name(house)} pressed={value === house} onPress={() => onChange(house)}>
					<ModelIcon brand={house === "other" ? null : house} size={16} />
				</RailButton>
			))}
		</nav>
	);
}

function RailButton({
	label,
	pressed,
	onPress,
	children,
}: {
	label: string;
	pressed: boolean;
	onPress: () => void;
	children: React.ReactNode;
}) {
	return (
		<IconButton
			label={label}
			icon={children}
			active={pressed}
			onClick={(event) => {
				onPress();
				// Back to the search field, so arrows and Enter keep working after a press here.
				event.currentTarget.closest("[data-ly-popover]")?.querySelector("input")?.focus();
			}}
		/>
	);
}
