import type { WebContents } from "electron";
import { nativeText } from "./i18n.ts";

/**
 * 页面的 alert、confirm、离开页面提示，在 agent 操作网页时由这里应答。
 *
 * 不接管时，Electron 弹一个系统对话框等人去点，而页面的主线程就停在那一句上：agent 接下来每一次读页面、
 * 点按钮都等满 15 秒报「页面没有响应」，直到有人碰巧看到那个对话框。
 *
 * 只在 agent 的浏览器调用进行时接管，人自己浏览时照旧是系统对话框。`prompt` 不在这里：Electron 不实现它，
 * 页面调用时直接拿到 null，不会停住。
 *
 * 为什么不用 CDP 的 `Page.handleJavaScriptDialog`：它让页面继续了，Electron 弹出的系统对话框却留在窗口上，
 * 一个个排着，直到页面跳走——量到过 agent 早已走远，人面前还停着第一个 alert。系统对话框是 Electron 的
 * JS 层在 `-run-dialog` 上弹的（44.x 的 `lib/browser/api/web-contents.ts`），所以在那里分岔：agent 的
 * 由这里直接答，人的交回原来的监听。
 */
export interface MetDialog { type: string; message: string; accepted: boolean }

type Answer = (accepted: boolean, text: string) => void;
interface RunDialog { dialogType: string; messageText: string }
interface Call { accept: boolean; met: MetDialog[] }
interface Opened { type: string; message: string; owner: string; answer: Answer }

/** 进行中的调用，按会话。 */
const calls = new Map<string, Call>();
/** 正以系统对话框开着、等人点的：在两次调用之间弹出的，等下一次调用来收。 */
const waiting = new Map<WebContents, Opened>();

/** 一页挂上时调：之后它弹的对话框都先经过这里。 */
export function watchDialogs(contents: WebContents, owner: () => string | null, stayed: () => void): void {
	const events = contents as unknown as NodeJS.EventEmitter;
	const listeners = events.listeners("-run-dialog");
	// 认不出 Electron 自己的那一个（换了版本、换了实现），就不接管：系统对话框总比丢掉对话框好。
	if (listeners.length !== 1) return;
	const native = listeners[0] as (info: RunDialog, answer: Answer) => void;
	events.removeListener("-run-dialog", native);
	events.on("-run-dialog", (info: RunDialog, answer: Answer) => {
		const dialog = { type: info.dialogType, message: info.messageText, owner: owner() ?? "", answer };
		const call = calls.get(dialog.owner);
		if (call && dialog.type !== "prompt") { reply(dialog, call); return; }
		waiting.set(contents, dialog);
		native(info, (accepted, text) => {
			waiting.delete(contents);
			answer(accepted, text);
		});
	});
	// 离开页面提示：Electron 不弹窗，默认留在原页；`preventDefault` 是离开。
	contents.on("will-prevent-unload", (event) => {
		const call = calls.get(owner() ?? "");
		if (!call) return;
		call.met.push({ type: "beforeunload", message: "", accepted: call.accept });
		if (call.accept) event.preventDefault();
		// 留在这一页：等着新页的那一方不会等到新文档，告诉它旧文档照旧能读。
		else stayed();
	});
	contents.once("destroyed", () => waiting.delete(contents));
}

function reply(dialog: Opened, call: Call): void {
	// alert 只有一个按钮。confirm 默认取消：替 agent 点下的「确定删除」收不回来，
	// 要确认，它在同一个操作上带 `dialog: "accept"` 再做一次。
	const accepted = dialog.type === "alert" || call.accept;
	call.met.push({ type: dialog.type, message: dialog.message, accepted });
	dialog.answer(accepted, "");
}

/** 一次 agent 调用：期间这个会话的页面弹出的对话框都由它应答，连同调用开始前就开着、没人应答的。 */
export async function answeringDialogs<T>(sessionId: string, accept: boolean, run: () => Promise<T>): Promise<{ value: T; met: MetDialog[] }> {
	const call: Call = { accept, met: [] };
	calls.set(sessionId, call);
	for (const [contents, dialog] of waiting) {
		if (dialog.owner !== sessionId) continue;
		waiting.delete(contents);
		// 收起那个系统对话框。Electron 收起时不回调，所以由这里回答，页面只收到这一个答复。
		(contents as unknown as NodeJS.EventEmitter).emit("-cancel-dialogs", { resetState: false });
		reply(dialog, call);
	}
	try {
		return { value: await run(), met: call.met };
	} finally {
		if (calls.get(sessionId) === call) calls.delete(sessionId);
	}
}

export function describeDialogs(met: MetDialog[]): string {
	return met.map((dialog) => {
		if (dialog.type === "alert") return nativeText("browser.dialogAlert", { message: dialog.message });
		// 离开页面的提示网页写不了字，所以照它的意思说。
		if (dialog.type === "beforeunload") return nativeText(dialog.accepted ? "browser.leaveAccepted" : "browser.leaveDismissed");
		return nativeText(dialog.accepted ? "browser.dialogAccepted" : "browser.dialogDismissed", { type: dialog.type, message: dialog.message });
	}).join("\n");
}
