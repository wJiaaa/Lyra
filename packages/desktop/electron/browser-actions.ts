import { BrowserWindow, screen, type NativeImage, type WebContents } from "electron";
import { browserContents, browserState, browserScale, historyBrowser, loadedBrowser, pointBrowser, selectBrowser } from "./browser-workspace.ts";
import { evaluatePage, locate, snapshotPage, waitPage, type Condition, type Target } from "./browser-locate.ts";

export async function readBrowser(id: string): Promise<unknown> {
	return snapshotPage(browserContents(id), id);
}

/**
 * 这一页此刻在面板里的样子，按点而不是按物理像素出图。
 *
 * `capturePage` 给的是物理像素：Retina 上每边两倍，模型那头按像素计费，同一张图贵四倍，多出来的细节
 * 对看懂页面没有帮助。图本身不带倍数（`getScaleFactors()` 只有 1），所以倍数读宿主窗口所在的那块屏。
 */
export async function captureBrowser(contents: WebContents): Promise<NativeImage> {
	const image = await contents.capturePage();
	const window = contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null;
	const factor = window ? screen.getDisplayMatching(window.getBounds()).scaleFactor : 1;
	if (!(factor > 1)) return image;
	const { width, height } = image.getSize();
	return image.resize({ width: Math.max(1, Math.round(width / factor)), height: Math.max(1, Math.round(height / factor)), quality: "best" });
}

export interface BrowserAction {
	action: "click" | "type" | "links" | "eval" | "read" | "scroll" | "press" | "hover" | "back" | "forward" | "reload" | "wait";
	ref?: string;
	selector?: string;
	text?: string;
	expression?: string;
	x?: number;
	y?: number;
	timeout?: number;
}

export async function actBrowser(id: string, action: BrowserAction, sessionId?: string): Promise<unknown> {
	const contents = browserContents(id, sessionId);
	// Selected, never revealed: the panel is the person's to open. See `openBrowser`.
	await selectBrowser(id, false);
	if (action.action === "read") return readBrowser(id);
	// 换了一页，读回来的就是 agent 下一步要看的东西，省掉紧跟着的那次 read。
	if (action.action === "back" || action.action === "forward" || action.action === "reload") {
		await historyBrowser(id, action.action, sessionId);
		return readBrowser(id);
	}
	if (action.action === "wait") return waitPage(contents, action satisfies Condition);
	if (action.action === "links") return evaluatePage(contents, `Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a=>({text:a.innerText,href:a.href}))`);
	if (action.action === "eval") {
		if (!action.expression) throw new Error("eval 需要 expression");
		return evaluatePage(contents, action.expression);
	}
	if (action.action === "scroll") {
		if (![action.x ?? 0, action.y ?? 0].every(Number.isFinite)) throw new Error("滚动距离必须为数字");
		pointBrowser(id, { ...await locate(contents, {}, false), action: "scroll" });
		return evaluatePage(contents, `window.scrollBy({left:${action.x ?? 0},top:${action.y ?? 0},behavior:'instant'})`);
	}
	if (action.action === "press") {
		const key = action.text;
		if (!key || !["Enter", "Tab", "Escape", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Space", "Home", "End"].includes(key)) throw new Error("press 需要 Enter/Tab/Escape/Backspace/Delete/Up/Down/Left/Right/Space/Home/End");
		contents.focus();
		const pointer = browserState().tabs.find((tab) => tab.id === id)?.pointer;
		pointBrowser(id, { ...pointer ?? await locate(contents, {}, false), action: "press" });
		contents.sendInputEvent({ type: "keyDown", keyCode: key });
		contents.sendInputEvent({ type: "keyUp", keyCode: key });
		return { pressed: key };
	}
	if (!action.ref && !action.selector) throw new Error("操作需要 read 给出的 ref，或当前页面中确认过的 selector");
	contents.focus();
	const target: Target = action.ref ? { ref: action.ref } : { selector: action.selector };
	const point = await locate(contents, target, action.action !== "hover");
	pointBrowser(id, { ...point, action: action.action });
	const zoom = browserState().tabs.find((tab) => tab.id === id)?.zoom ?? 1;
	const position = { x: Math.round(point.x * zoom * browserScale(id)), y: Math.round(point.y * zoom * browserScale(id)) };
	contents.sendInputEvent({ type: "mouseMove", ...position });
	if (action.action === "hover") return point;
	/*
	 * 点的是链接、提交按钮时，下面那一帧要在一张正被卸掉的文档里等，脚本永远回不来：量到过每点一次链接
	 * 白等 15 秒，报「页面没有响应」，而页面其实已经过去了。所以点之前就听着主框架换文档，换了就去等新页。
	 */
	let leave = (_details: { isMainFrame: boolean; isSameDocument: boolean }) => {};
	const left = new Promise<true>((resolve) => {
		leave = (details) => { if (details.isMainFrame && !details.isSameDocument) resolve(true); };
		contents.on("did-start-navigation", leave);
	});
	contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...position });
	contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...position });
	/*
	 * Native input is queued in the guest; a frame observes its committed focus and DOM effects.
	 *
	 * A frame, or a tenth of a second if none comes. An agent's page whose conversation is off screen
	 * sits in a `visibility: hidden` host and draws no frames — while telling itself it is visible:
	 * measured, `document.visibilityState` reads "visible" there, so it cannot be asked. Waiting on
	 * the frame alone timed out at 15 seconds and reported the page unresponsive after a click that
	 * had in fact landed, on every click, for as long as the person looked at another conversation.
	 * Press and release are discrete events and are not held for a frame, so the fallback still
	 * waits on something real; on screen the frame arrives first and nothing changes.
	 */
	const frame = evaluatePage(contents, "new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 100); })").then(() => false as const);
	const navigated = await Promise.race([frame, left]).finally(() => contents.off("did-start-navigation", leave));
	if (navigated) {
		void frame.catch(() => {});
		await loadedBrowser(id, sessionId);
		return { action: action.action, url: contents.getURL(), point, navigated: true };
	}
	if (action.action === "type") {
		if (action.text === undefined) throw new Error("type 需要 text");
		await evaluatePage(contents, `(() => {const el=document.activeElement;if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement){el.select();}else if(el?.isContentEditable){const s=getSelection();const r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);}else{throw new Error('目标不是输入框');}})()`, true);
		await contents.insertText(action.text);
	}
	return { action: action.action, url: contents.getURL(), point };
}
