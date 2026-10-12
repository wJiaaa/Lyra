import { ListOrdered } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useApp } from "../../store/index.ts";
import { useI18n } from "../../i18n/index.ts";

/**
 * 计划模式的指示兼开关，挨着权限芯片。
 *
 * 关着时是工具栏里一颗淡色图标，和加附件那颗同一种按钮：常驻，免得这一排因为一个模式时有时无地
 * 跳宽度。开着时才带字、换成强调色——这是一个会改变「模型这一轮能做什么」的状态，开着却看不出来，
 * 人会奇怪它为什么不动手。
 */
export function PlanModeToggle({ sessionId, on }: { sessionId: string | null; on: boolean }) {
	const { t } = useI18n();
	const toggle = () => void useApp.getState().setPlanMode(!on, sessionId);

	if (!on) return (
		<IconButton
			size="composer"
			label={t("plan.enter")}
			tipSide="top"
			active={false}
			onClick={toggle}
			icon={<ListOrdered size={16} strokeWidth={1.9} />}
		/>
	);
	return (
		<button
			type="button"
			data-ly-tip={t("plan.exit")}
			data-ly-tip-side="top"
			aria-label={t("plan.exit")}
			aria-pressed
			onClick={toggle}
			className="ly-composer-control flex shrink-0 items-center gap-1 rounded-lg bg-accent/10 px-2 text-label text-accent transition-colors duration-[var(--ly-t-quick)] hover:bg-accent/15"
		>
			<ListOrdered size={16} strokeWidth={1.9} className="shrink-0" />
			{/* 和「完全访问」的字一起让位：图标是强调色、悬停有提示，字是这一排最便宜的东西。见 `fit.ts`。 */}
			<span data-ly-fit-drop="1" className="whitespace-nowrap">{t("plan.chip")}</span>
		</button>
	);
}
