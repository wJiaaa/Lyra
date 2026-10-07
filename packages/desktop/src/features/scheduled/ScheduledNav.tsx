/**
 * The schedule's sidebar: every task by name, and a new one.
 *
 * A row brings its card into view rather than opening a page of its own — the cards are where a task
 * is edited, and with a handful of them a page each would be a click more for nothing.
 */

import type { ScheduledTask } from "@plume/core";
import { Clock, Plus } from "../../ui/icons/index.ts";

import { NavSlotHead, NavSlotRow } from "../../app/nav-slot.tsx";
import { useI18n } from "../../i18n/index.ts";
import { SessionStatus } from "../conversation/index.ts";
import { useScheduledNotices } from "./notices.ts";
import { useTaskStatus } from "./useTaskStatus.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";

export function ScheduledNav({ tasks, onAdd }: { tasks: readonly ScheduledTask[]; onAdd: () => void }) {
	const { t } = useI18n();
	return (
		<>
			<NavSlotHead title={t("scheduled.title")} />
			<nav className="flex flex-col px-2.5 pb-1">
				<NavSlotRow data-scheduled-new="" icon={<Plus size={16} />} label={t("scheduled.create")} onClick={onAdd} />
			</nav>
			<Scroller className="flex-1" contentClassName="flex flex-col gap-[2px] px-2.5 pt-2 pb-2">
				{tasks.map((task) => (
					<TaskRow key={task.id} task={task} />
				))}
			</Scroller>
		</>
	);
}

function TaskRow({ task }: { task: ScheduledTask }) {
	const { t } = useI18n();
	const status = useTaskStatus(task);
	return (
		<NavSlotRow
			data-scheduled-nav={task.id}
			icon={<Clock size={15} strokeWidth={1.8} className="text-ink-muted" />}
			label={task.name}
			// Paused is fainter, not gone: it is still there to be switched back on.
			muted={!task.enabled}
			onClick={() => useScheduledNotices.setState({ focus: task.id })}
			trailing={
				status ? (
					<SessionStatus activity={status} />
				) : task.lastError ? (
					<span data-ly-tip={t("scheduled.failedBecause", { reason: task.lastError })} className="h-[6px] w-[6px] shrink-0 rounded-full bg-danger" />
				) : undefined
			}
		/>
	);
}
