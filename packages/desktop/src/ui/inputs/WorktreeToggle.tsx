/**
 * This conversation in a worktree of its own, or in the project itself.
 *
 * Chosen per conversation, before its first message — the only moment the choice means anything, since
 * a conversation that has run cannot be moved into a copy afterwards. It starts from
 * `worktrees.autoCreateOnNewSession`, which is now only the default: that setting used to be the only
 * way to choose at all, all or nothing for every conversation after it.
 *
 * A toggle beside the project and branch, not a menu: there are two answers, and both are visible in
 * one glance — the mark alone, or the mark and its name in the accent colour, the way `PlanModeToggle`
 * says the same of plan mode. The fork is the mark the sidebar puts on a conversation that got one
 * (`SessionStatus`), and not the branch chip's beside it.
 *
 * Down here rather than in a domain because two ask the question — the composer, for the conversation
 * being written, and a suggested conversation's card, for the one it starts.
 */

import { GitFork } from "../icons/index.ts";
import { useI18n } from "../../i18n/index.ts";

export function WorktreeToggle({
	on,
	onChange,
	size = "composer",
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** `sm` beside a `Button size="sm"`, as on a suggestion card: 26px, where the composer's controls are 28px. */
	size?: "composer" | "sm";
}) {
	const { t } = useI18n();
	const tip = on ? t("composer.worktreeOn") : t("composer.worktreeOff");
	return (
		<button
			type="button"
			data-ly-worktree-toggle=""
			aria-pressed={on}
			aria-label={tip}
			data-ly-tip={tip}
			data-ly-tip-side="top"
			onClick={() => onChange(!on)}
			className={`${size === "sm" ? "h-[26px] min-w-[26px]" : "ly-composer-control min-w-[var(--ly-composer-control)]"} flex shrink-0 items-center gap-1 rounded-lg px-[6px] text-label transition-colors duration-[var(--ly-t-quick)] ${
				on ? "bg-accent/10 text-accent hover:bg-accent/15" : "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated"
			}`}
		>
			<GitFork size={16} strokeWidth={1.8} className="shrink-0" aria-hidden />
			{on && <span className="whitespace-nowrap pr-0.5">{t("composer.worktree")}</span>}
		</button>
	);
}
