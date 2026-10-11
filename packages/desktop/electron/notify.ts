/**
 * System notification on agent task events.
 *
 * Emits an OS notification when an agent finishes its work or asks for user assistance
 * while the user is away from the app window. Clicking the notification restores and
 * focuses the window, navigating directly to the conversation.
 *
 * The text is in the interface language, from the main process's own catalog in `i18n.ts` —
 * the renderer's `translate` is not reachable from here.
 */

import type { AgentEvent, GoalState } from "@plume/core";
import { nativeText } from "./i18n.ts";

export interface NotificationInstance {
	show(): void;
	on(event: "click", listener: () => void): void;
}

export interface TaskDoneDetails {
	sessionId: string;
	title?: string;
}

export interface NeedAssistanceDetails {
	sessionId: string;
	title?: string;
	question?: string;
	kind?: "question" | "approval";
}

/**
 * All pending decisions need attention while their conversation is out of view.
 *
 * `goal` 是这个会话此刻的持续目标。目标进行中，一轮收尾只是裁判要看的一步，不是「做完了」——
 * 每轮都响一下，人就学会了不理它，真到终态那一声也一起被忽略。所以进行中不报每轮，只报终态。
 */
export function notifyAgentEvent(sessionId: string, event: AgentEvent, title?: string, goal?: GoalState): void {
	if (event.type === "agent_end" && event.reason === "done" && !goalUnderway(goal)) notifyTaskDone({ sessionId, title });
	if (event.type === "goal" && event.goal && ENDED.has(event.goal.status)) notifyGoalEnded(sessionId, event.goal);
	if (event.type === "approval_request") {
		const question = event.kind === "interactive" || event.subject === "ask_user";
		// 后台子智能体问的，说出是谁在问——人要据此决定的，正是「这个活该不该由它来干」。
		const asking = question ? event.detail || event.reason : event.title;
		notifyNeedAssistance({ sessionId, title, kind: question ? "question" : "approval", question: event.from && asking ? nativeText("notification.asking", { agent: event.from.description, question: asking }) : asking });
	}
}

export interface WindowLike {
	isDestroyed(): boolean;
	isVisible(): boolean;
	isFocused(): boolean;
	isMinimized(): boolean;
}

interface NotificationOptionsLike {
	title: string;
	body: string;
	icon?: string;
	silent?: boolean;
}

export interface NotifyDeps {
	isSupported(): boolean;
	window(): WindowLike | null;
	appIcon(): string | undefined;
	sendTrayCommand(command: `open-session:${string}`): void;
	createNotification(options: NotificationOptionsLike): NotificationInstance;
}

let deps: NotifyDeps = {
	isSupported: () => false,
	window: () => null,
	appIcon: () => undefined,
	sendTrayCommand: (_cmd) => {},
	createNotification: () => ({
		show: () => {},
		on: () => {},
	}),
};

export function configureNotify(next: Partial<NotifyDeps>): void {
	deps = { ...deps, ...next };
}

function isWindowActive(win: WindowLike | null): boolean {
	return Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized());
}

/**
 * Triggered when a turn finishes with reason "done".
 * Suppressed if the user is already looking at the focused window.
 */
export function notifyTaskDone(details: TaskDoneDetails): void {
	if (!deps.isSupported()) return;
	if (isWindowActive(deps.window())) return;

	const sessionTitle = details.title?.trim();
	const body = sessionTitle ? nativeText("notification.done", { title: sessionTitle }) : nativeText("notification.doneUntitled");
	const icon = deps.appIcon();

	const notification = deps.createNotification({
		title: "Plume",
		body,
		...(icon ? { icon } : {}),
		silent: false,
	});

	notification.on("click", () => {
		// The shared tray dispatcher reveals the window and waits for a cold renderer.
		deps.sendTrayCommand(`open-session:${details.sessionId}`);
	});

	notification.show();
}

const UNDERWAY = new Set<GoalState["status"]>(["working", "judging", "waiting"]);
const ENDED = new Set<GoalState["status"]>(["met", "impossible", "paused"]);

function goalUnderway(goal: GoalState | undefined): boolean {
	return goal !== undefined && UNDERWAY.has(goal.status);
}

/** 持续目标到了终态：达成、走不到、停下来等人。和别的通知一样，人正看着窗口就不打扰。 */
function notifyGoalEnded(sessionId: string, goal: GoalState): void {
	if (!deps.isSupported()) return;
	if (isWindowActive(deps.window())) return;
	const body = goal.status === "met"
		? nativeText("notification.goalMet", { goal: goal.text })
		: goal.status === "impossible"
			? nativeText("notification.goalImpossible", { goal: goal.text })
			: nativeText("notification.goalPaused", { goal: goal.text, why: nativeText(`notification.goalPause.${goal.pausedFor ?? "user"}`) });
	const icon = deps.appIcon();
	const notification = deps.createNotification({ title: "Plume", body, ...(icon ? { icon } : {}), silent: false });
	notification.on("click", () => deps.sendTrayCommand(`open-session:${sessionId}`));
	notification.show();
}

/**
 * Triggered when an agent requests user assistance or choices via ask_user.
 * Suppressed if the user is actively viewing the focused window.
 */
export function notifyNeedAssistance(details: NeedAssistanceDetails): void {
	if (!deps.isSupported()) return;
	if (isWindowActive(deps.window())) return;

	const sessionTitle = details.title?.trim();
	const question = details.question?.trim().replace(/\s+/g, " ");
	const questionSummary = question ? (question.length > 80 ? `${question.slice(0, 77)}...` : question) : undefined;

	const approval = details.kind === "approval";
	const status = sessionTitle
		? nativeText(approval ? "notification.approval" : "notification.reply", { title: sessionTitle })
		: nativeText(approval ? "notification.approvalUntitled" : "notification.replyUntitled");
	const body = questionSummary ? nativeText("notification.detail", { status, detail: questionSummary }) : status;

	const icon = deps.appIcon();
	const notification = deps.createNotification({
		title: "Plume",
		body,
		...(icon ? { icon } : {}),
		silent: false,
	});

	notification.on("click", () => {
		deps.sendTrayCommand(`open-session:${details.sessionId}`);
	});

	notification.show();
}
