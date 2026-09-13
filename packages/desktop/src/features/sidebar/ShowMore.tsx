import { ChevronDown, ChevronUp } from "lucide-react";
import { translate } from "../../i18n/translate.ts";
import { useLayout } from "../../app/layout.tsx";
import { RollingText } from "../../ui/motion/RollingText.tsx";

/**
 * The pager under a run of conversation rows.
 *
 * Two separate actions rather than one toggle. "More" and "back to the top" are different
 * intentions, and a single control that means whichever one the current state implies makes the
 * second press unpredictable. The count is what is left, not what a press will reveal — how much
 * more there is is the question being asked.
 *
 * Shared by a project's block and by the 「最近」 section, which both cap what they show for the
 * same reason: forty rows under one heading is a wall, and the way back from it used to be a
 * single 收起 that threw away however far you had read.
 *
 * Indented to where the titles start, so it reads as part of the list it pages rather than as a
 * control belonging to the pane.
 */
export function ShowMore({
	hidden,
	canCollapse,
	onShowMore,
	onCollapse,
}: {
	/** How many rows are still not shown. */
	hidden: number;
	canCollapse: boolean;
	onShowMore: () => void;
	onCollapse: () => void;
}) {
	const { compact } = useLayout();
	if (hidden <= 0 && !canCollapse) return null;

	return (
		<div /*
			 * 30px, not a Tailwind step: it lines this row's text up with the session titles above it,
			 * which sit at the dot's left edge plus the dot's own 14px plus the 8px gap. Every one of
			 * those is fixed, so the sum is too.
			 */
			className={`flex items-center gap-3 pl-[30px] ${compact ? "h-[32px]" : "h-[26px]"}`}>
			{hidden > 0 && (
				<button
					type="button"
					data-ly-tip={translate("showMore.expand", { n: hidden })}
					aria-label={translate("showMore.expand", { n: hidden })}
					onClick={onShowMore}
					className="flex items-center gap-1 text-left text-label text-ink-faint transition-colors hover:text-ink-muted"
				>
					{/*
					 * 数字留着，「还有…条」进 tooltip。
					 *
					 * 剩几条是这一行存在的理由——一个光秃秃的箭头说不出「还有 37 条」和「还有 2 条」
					 * 的差别，而那正是决定要不要按的东西。滚动效果也留在数字上，它本来就是为数字做的：
					 * 按一下，37 滚成 32。
					 */}
					<ChevronDown size={12} strokeWidth={2} aria-hidden />
					<RollingText>{String(hidden)}</RollingText>
				</button>
			)}
			{canCollapse && (
				<button
					type="button"
					data-ly-tip={translate("common.collapse")}
					aria-label={translate("common.collapse")}
					onClick={onCollapse}
					className="grid h-[18px] w-[18px] place-items-center rounded text-ink-faint transition-colors hover:text-ink-muted"
				>
					<ChevronUp size={12} strokeWidth={2} aria-hidden />
				</button>
			)}
		</div>
	);
}
