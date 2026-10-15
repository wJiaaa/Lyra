/**
 * The conversation beside the conversation.
 *
 * A session of its own (`SessionMeta.parentId`), so its transcript is drawn by the same
 * `Conversation` the main column uses — same rows, tool cards, approvals — pointed at it through
 * `SessionScope`. It can read and change the project like the main session, reads what the main
 * session is doing before each question, and can hand work to the main session's queue, which is
 * what `TaskStrip` below the messages reports on.
 *
 * The session behind a panel is created on the first question (`askSide`); until then the panel
 * shows its empty state. What sits under the transcript — `TaskStrip` and `SideComposer` — stays in
 * the main session's scope: the queue is the main session's, and 「跟随主会话」 follows it.
 */

import { translate } from "../../i18n/translate.ts";
import { MessageCirclePlus } from "../../ui/icons/index.ts";
import { useEffect, useState } from "react";
import { loadSide, sideKey, sideOf, useSide } from "../dock/index.ts";
import { sideDraftKey, useSideTarget } from "./target.ts";
import { Conversation } from "../conversation/index.ts";
import { sideIdOfPanel } from "../../lib/panel-instance.ts";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { SessionScope } from "../../app/session-scope.tsx";
import { useApp } from "../../store/index.ts";
import { Confirm } from "../../ui/overlay/Confirm.tsx";
import { ChoiceMark } from "../../ui/primitives/ChoiceMark.tsx";
import { askBeforeClosing, showingSide, sideHasTranscript, useSideCloseQuestion } from "./close-guard.ts";
import { SideComposer } from "./SideComposer.tsx";
import { TaskStrip } from "./TaskStrip.tsx";

export function SideChat() {
	const { sessionId, sideId } = useSideTarget();
	const side = useSide((s) => sideOf(s, sessionId, sideId));
	/*
	 * 这一屏的会话旁边有哪几格、任务队列里有什么，由这个面板自己去拉。
	 *
	 * 从前只有 `ChatShell` 拉一次「当前会话」的，于是分屏里另一屏的侧边聊天要么是空的，要么画
	 * 的是别人的。面板知道自己属于谁，就该自己开口要；`attach` 重复叫不会出错。
	 */
	useEffect(() => {
		void useSide.getState().attach(sessionId);
	}, [sessionId]);
	const sideSessionId = side?.id ?? null;
	useEffect(() => {
		if (side) void loadSide(side);
		// 换了一个会话才重读；同一个会话的 meta 变了（标题、模型）不用。
		// oxlint-disable-next-line exhaustive-deps
	}, [sideSessionId]);
	/*
	 * 有话可画才画转录。还没读进来的时候看记录里有没有：有就交给转录画它的加载，没有就是空的那一格。
	 */
	const said = useApp((s) => sideHasTranscript(s, side));
	const key = sessionId ? sideKey(sessionId, sideId) : null;
	useEffect(() => (key ? showingSide(key) : undefined), [key]);
	const question = useSideCloseQuestion((state) => (key && state.asking?.key === key ? state.asking : null));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{!sessionId ? (
				// It reads the conversation it is attached to; without one there is nothing to be
				// beside.
				<PanelEmpty icon={MessageCirclePlus} title={translate("dock.sideChat")}>
					{translate("sideChat.needSession")}
				</PanelEmpty>
			) : side && said ? (
				<SessionScope.Provider value={side.id}>
					<Conversation side />
				</SessionScope.Provider>
			) : (
				<PanelEmpty icon={MessageCirclePlus} title={translate("dock.sideChat")}>
					{translate("sideChat.empty")}
				</PanelEmpty>
			)}

			<TaskStrip />
			<SideComposer side={side} disabled={!sessionId} />
			{question && <CloseQuestion answer={question.answer} />}
		</div>
	);
}

function CloseQuestion({ answer }: { answer: (close: boolean, dontAskAgain?: boolean) => void }) {
	const [dontAskAgain, setDontAskAgain] = useState(false);
	return (
		<Confirm
			title={translate("sideChat.closeConfirm")}
			detail={translate("sideChat.closeConfirmDetail")}
			confirmLabel={translate("sideChat.closeConfirmAction")}
			onConfirm={() => answer(true, dontAskAgain)}
			onCancel={() => answer(false)}
		>
			<label className="group flex w-fit cursor-pointer items-center gap-2 text-label text-ink select-none">
				<input type="checkbox" className="sr-only" checked={dontAskAgain} onChange={(event) => setDontAskAgain(event.target.checked)} />
				<ChoiceMark checked={dontAskAgain} kind="checkbox" />
				{translate("sideChat.dontAskAgain")}
			</label>
		</Confirm>
	);
}

/**
 * 侧边聊天那个标签上写什么：它问的第一句话，还没开口的写「侧边聊天」。
 *
 * 一个会话旁边开了好几个时，一排「侧边聊天」分不出谁是谁。标题是会话自己的（第一次提问时由运行时
 * 取那句话的第一行，见 core `AgentSession.nameAfterQuestion`）。见 `PanelDefinition.tabTitle`；
 * `scope` 就是这一屏的会话 id。
 */
export function SideChatTitle({ scope, kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const sideId = sideIdOfPanel(kind) ?? "";
	const id = useSide((s) => sideOf(s, scope, sideId)?.id ?? null);
	const listed = useSide((s) => sideOf(s, scope, sideId)?.title ?? "");
	// 缓存里那份跟着 `title` 事件走，比列表里那份先到。
	const title = useApp((s) => (id ? s.sessionCache[id]?.meta.title : undefined)) ?? listed;
	return title ? <span data-ly-tip={title}>{title}</span> : <>{fallback}</>;
}

/**
 * 关掉一个侧边聊天：停下，会话连同记录一起删，最早那一个也一样。输入框里没发出去的字和引文也扔掉。
 *
 * 关掉就是不要了。从前最早那一个关掉只算收起，重开还是上一段，于是要清空只能找面板上那颗「重置」，
 * 而「关掉又打开，旧的还在」本身就被当成了毛病。草稿从前漏在这条之外：会话删了，框里划进来的引文
 * 还在，重开一格又原样摆回来。
 */
export function closeSideChat(scope: string, kind: string): void {
	const sideId = sideIdOfPanel(kind);
	if (!sideId) return;
	void useSide.getState().close(scope, sideId);
	useSide.getState().clearDraftSeed(scope, sideId);
	useApp.getState().setDraft(sideDraftKey(scope, sideId), null);
}

/**
 * 关之前问一句，只在里面有东西时问——见 `close-guard.ts`。
 *
 * 写在这里而不是 `close-guard.ts`：量「有没有东西」要读 `dock` 的大门，那个文件 import 它会成环
 * （`scope.ts` 开头那段）。这个文件本来就读它，`closeSideChat` 也在这里。
 */
export function confirmCloseSideChat(scope: string, kind: string): Promise<boolean> {
	const sideId = sideIdOfPanel(kind);
	if (!sideId) return Promise.resolve(true);
	const app = useApp.getState();
	const draft = app.drafts[sideDraftKey(scope, sideId)];
	// 只挂着划进来的引文、会话引用不算：从屏幕上再划一下就回来了，为它拦一次不值。
	const typed = !!draft && (draft.text.trim() !== "" || draft.attachments.length > 0);
	return askBeforeClosing(sideKey(scope, sideId), typed || sideHasTranscript(app, sideOf(useSide.getState(), scope, sideId)));
}
