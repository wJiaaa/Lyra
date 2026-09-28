import type { MessageKey } from "../../i18n/messages/index.ts";
import { translate } from "../../i18n/translate.ts";
import type { SessionActivity } from "@lyra/core/activity";

import { StatusSpinner } from "../../ui/motion/loaders.tsx";

/** Keys, looked up when the row is drawn — this table is built at import time. */
const LABEL: Record<SessionActivity, MessageKey> = {
	running: "sessionStatus.running",
	waiting: "sessionStatus.waiting",
	done: "sessionStatus.done",
	failed: "sessionStatus.failed",
};

/**
 * What a conversation in the list is doing, in the space of one character.
 *
 * Four things can be true of a conversation and only one of them is visible from a title: it may
 * be running right now, it may have stopped to ask permission and be waiting indefinitely for an
 * answer, it may have finished or failed since you last looked, or there may be nothing to say.
 * Without this the third case is invisible and the second is worse than invisible — an agent
 * waits forever for approval nobody knows it needs.
 *
 * Idle keeps its place rather than collapsing. Every row reserves the same width whatever its
 * state, so titles line up as a column and a mark appearing does not shove one sideways; the
 * faint ring standing in for "nothing" is quiet enough to read as part of the rule.
 */
export function SessionStatus({ activity, unread = false }: { activity: SessionActivity | null; unread?: boolean }) {
	/*
	 * 手动标的未读只占空闲那一档。在跑、在等批准说的是接下来要发生的事，比「回头再看」要紧；
	 * `done`/`failed` 本身就是未读，不用再叠一层。
	 */
	const label = activity ? translate(LABEL[activity]) : unread ? translate("sessionStatus.unread") : undefined;
	return (
		<span
			className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-visible"
			data-ly-tip={label}
			data-ly-tip-side="right"
			aria-label={label}
			role={label ? "img" : undefined}
		>
			{activity === "running" ? (
				/*
				 * 比槽位小一圈：14px 的槽画 12px 的环，和同列 7px 的点放在一起不至于太重。虚线环六段
				 * 等分、没有端点，一列里好几行同时在转也不会各自勾一下视线。
				 */
				<span data-ly-status-mark="running" className="flex text-accent">
					<StatusSpinner size={12} />
				</span>
			) : (
				/*
				 * One 7px disc, four paints. Switching a finished conversation in used to swap a
				 * 7px fill for a 6px ring, which is the hop the eye reports as the row jumping.
				 */
				<span
					data-ly-status-mark={activity ?? (unread ? "unread" : "idle")}
					className={`box-border block h-[7px] w-[7px] rounded-full transition-colors duration-[var(--ly-t-quick)] ${
						activity === "waiting"
							? "ly-pulse bg-accent"
							: activity === "done"
								? "bg-ok"
								: activity === "failed"
									? "bg-danger"
									: unread
										? "bg-info"
										: "border border-line"
					}`}
				/>
			)}
		</span>
	);
}
