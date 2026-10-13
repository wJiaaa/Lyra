import { ListOrdered } from "../../ui/icons/index.ts";
import { useApp } from "../../store/index.ts";
import { useI18n } from "../../i18n/index.ts";

/**
 * 计划模式的指示兼开关，挨着权限芯片。
 *
 * 关着时是工具栏里一颗淡色图标，和加附件那颗一个样子：常驻，免得这一排因为一个模式时有时无地
 * 跳宽度。开着时才带字、换成强调色——这是一个会改变「模型这一轮能做什么」的状态，开着却看不出来，
 * 人会奇怪它为什么不动手。
 */
export function PlanModeToggle({ sessionId, on }: { sessionId: string | null; on: boolean }) {
	const { t } = useI18n();
	const toggle = () => void useApp.getState().setPlanMode(!on, sessionId);
	const label = t(on ? "plan.exit" : "plan.enter");

	/*
	 * 开和关必须是同一颗按钮、同一个左内边距。原先关着用 `IconButton`（图标在 28px 方块里居中，离左沿
	 * 6px）、开着另写一颗 `px-2` 的（8px）：一点图标就横跳 2px，而且整颗按钮被卸载重建，颜色过渡无从
	 * 谈起，背景是硬切的。左右 6px 让关着时正好是 28px 的方块；字右边差的那 2px 补在字上，字被 `fit.ts`
	 * 收掉时芯片退回方块，图标仍然居中。
	 */
	return (
		<button
			type="button"
			data-ly-tip={label}
			data-ly-tip-side="top"
			aria-label={label}
			aria-pressed={on}
			onClick={toggle}
			className={`ly-composer-control flex min-w-[var(--ly-composer-control)] shrink-0 items-center gap-1 rounded-lg px-[6px] text-label transition-colors duration-[var(--ly-t-quick)] ${
				on ? "bg-accent/10 text-accent hover:bg-accent/15" : "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated"
			}`}
		>
			<ListOrdered size={16} strokeWidth={1.9} className="shrink-0" />
			{/* 和「完全访问」的字一起让位：图标是强调色、悬停有提示，字是这一排最便宜的东西。见 `fit.ts`。 */}
			{on && <span data-ly-fit-drop="1" className="whitespace-nowrap pr-0.5">{t("plan.chip")}</span>}
		</button>
	);
}
