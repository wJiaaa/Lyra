import { focusScreenOf } from "../../app/session-scope.tsx";
import { afterPaint } from "../../lib/after-paint.ts";
import { useApp } from "../../store/index.ts";

/**
 * 从对话里的一处跳到另一个会话：引用的会话胶囊、另一个会话写来的信，都走这里。
 *
 * 不认识这个 id（会话已经删了）答 false，提示由调用方说——它知道该怎么称呼那个会话。
 */
export function jumpToSession(from: string | null, targetId: string): boolean {
	const target = useApp.getState().sessions.find((s) => s.id === targetId);
	if (!target) return false;
	/*
	 * Where it was pressed. A press on another screen focuses that screen first, so the
	 * conversation took its place; the keyboard reaches the capsule without that press,
	 * and it replaced the screen with focus instead. This screen takes the live slot the
	 * way the press does, and the split does the rest — in place of this screen, or by
	 * moving the focus to the screen already showing it.
	 */
	if (from !== useApp.getState().activeSessionId) focusScreenOf(from);
	const epoch = useApp.getState().previewSession(target);
	void afterPaint().then(() => {
		if (useApp.getState().selectionEpoch !== epoch) return;
		void useApp.getState().openSession(target);
	});
	return true;
}
