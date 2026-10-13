import { randomUUID } from "node:crypto";
import { nativeImage, webContents, type BrowserWindow, type NativeImage, type WebContents } from "electron";
import { browserLocalPage, browserUrl, browserViewport, browserZoom, type BrowserCommand, type BrowserPointer, type BrowserState, type BrowserTab } from "../shared/browser.ts";
import { eachAppWindow } from "./window.ts";
import { openLocalPage } from "./local-page.ts";
import { watchDialogs } from "./browser-dialogs.ts";
import { openOutside } from "./browser-outside.ts";

/**
 * The tab a command was for is gone — closed before it arrived, or while it waited for the page.
 *
 * A type of its own so the IPC boundary can tell it apart: for a person the close was the answer
 * already, while an agent still has to hear that its tab went away. See `ipc/browser.ts`.
 */
export class BrowserTabClosed extends Error {
	constructor() { super("浏览器标签已关闭"); }
}
/** `documentReady`：这一页的文档已经能读了，见 `loadedBrowser`；`wake` 叫醒正等着它换页的那一方。 */
interface Tab { size?: {width: number; height: number}; scale?: number; state: BrowserTab; contents?: WebContents; documentReady?: boolean; wake?: () => void; crashedAt?: number; ready: Promise<WebContents>; resolve: (contents: WebContents) => void; reject: (error: Error) => void }
const tabs = new Map<string, Tab>();
let activeId: string | null = null;
/**
 * The tab each conversation is on, keyed by session id (`""` for none).
 *
 * `activeId` is one value for the whole app — the last tab anybody selected — and reusing it for
 * "the tab to load into" meant an agent whose conversation was off screen either wrote over the
 * tab the user was looking at, or, once tabs were scoped per conversation, opened a new one on
 * every call. A conversation's current tab is a property of that conversation.
 */
const activeBySession = new Map<string, string>();
const sessionKey = (sessionId: string | null): string => sessionId ?? "";
function selectTab(tab: Tab): void {
	activeId = tab.state.id;
	activeBySession.set(sessionKey(tab.state.sessionId), tab.state.id);
}
let host: (() => BrowserWindow | null) = () => null;
let preferences: () => { defaultZoom?: number } = () => ({});
export function configureBrowser(window: () => BrowserWindow | null, settings: () => { defaultZoom?: number }): void { host = window; preferences = settings; }
export function browserState(): BrowserState { return { tabs: [...tabs.values()].map((tab) => ({ ...tab.state })), activeId }; }
function publish(reveal = false): void {
	const window = host();
	const recipients = new Set<WebContents>();
	if (window && !window.isDestroyed()) recipients.add(window.webContents);
	// Empty detached browsers need the first tab before they have a guest of their own.
	eachAppWindow((win) => recipients.add(win.webContents));
	for (const recipient of recipients) {
		if (!recipient.isDestroyed()) recipient.send("browser:changed", { ...browserState(), reveal });
	}
}
export function browserContents(id: string, sessionId?: string): WebContents {
	const tab = tabs.get(id);
	if (!tab || !tab.contents || tab.contents.isDestroyed()) throw new BrowserTabClosed();
	if (sessionId !== undefined && tab.state.sessionId !== sessionId) throw new Error("这个浏览器标签属于其他会话");
	return tab.contents;
}

/**
 * The same page, waited for rather than demanded.
 *
 * A tab whose conversation is off screen has no page behind it — the panel drops those to give the
 * renderer processes back — so an agent working in one would otherwise be told its own tab was
 * closed. Asking marks it `wanted`, which is the panel's cue to mount it again; the page comes back
 * at the address the tab still holds, which is the same recovery a discarded tab gets anywhere else.
 */
async function awakeBrowser(id: string, sessionId?: string): Promise<WebContents> {
	const tab = tabs.get(id);
	if (!tab) throw new BrowserTabClosed();
	if (sessionId !== undefined && tab.state.sessionId !== sessionId) throw new Error("这个浏览器标签属于其他会话");
	if (tab.contents && !tab.contents.isDestroyed()) return tab.contents;
	tab.state.wanted = true;
	publish();
	return readyBrowser(tab);
}

const NOT_LOADED = "页面 30 秒内没有加载出来，站点可能无法访问；标签还留着，可以稍后再读或关掉";

/**
 * 等这一页的文档能读了再交给 agent。
 *
 * 面板一挂上 `<webview>` 就算就绪，不等网站回应（见 `BrowserPage`）；从前两件事绑在一起，站点 30 秒
 * 不回首个响应，人和 agent 都收到一句「面板没有就绪」。agent 要读、要点的是文档，所以等它的那一步
 * 单独放在这里，超时说的是页面没加载出来，标签照旧留着。
 */
const crashed = (reason: string) => `页面进程又停止了（${reason}），不会自己恢复；要重试就 browser_act reload`;
export async function loadedBrowser(id: string, sessionId?: string): Promise<WebContents> {
	const contents = await awakeBrowser(id, sessionId);
	const tab = tabs.get(id);
	if (tab?.state.failure?.kind === "crash" && contents.isCrashed()) throw new Error(crashed(tab.state.failure.detail));
	if (!tab || tab.documentReady) return contents;
	let timer: NodeJS.Timeout | undefined;
	let settle = () => {};
	try {
		await Promise.race([
			new Promise<void>((resolve) => {
				settle = () => resolve();
				tab.wake = settle;
				contents.on("dom-ready", settle);
				contents.on("did-stop-loading", settle);
				contents.on("destroyed", settle);
			}),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(NOT_LOADED)), 30_000); }),
		]);
	} finally {
		clearTimeout(timer);
		tab.wake = undefined;
		if (!contents.isDestroyed()) {
			contents.off("dom-ready", settle);
			contents.off("did-stop-loading", settle);
			contents.off("destroyed", settle);
		}
	}
	// 等的时候页面被收走了：标签还在就再唤醒一次，不在了就是关了。
	if (contents.isDestroyed()) {
		if (!tabs.has(id)) throw new BrowserTabClosed();
		return loadedBrowser(id, sessionId);
	}
	// 等的时候页面进程又停了、不会自己回来，见 `render-process-gone`。
	if (tab.state.failure?.kind === "crash" && contents.isCrashed()) throw new Error(crashed(tab.state.failure.detail));
	return contents;
}
/**
 * agent 的后退、前进、刷新，交回时已经是那一页。
 *
 * 先等这一步落地（`did-navigate`，页内跳转是 `did-navigate-in-page`），再等文档：页内跳转没有加载事件，
 * 一上来就等文档会白等满时限；换了文档的，`did-start-navigation` 已把 `documentReady` 拨回去。
 */
export async function historyBrowser(id: string, step: "back" | "forward" | "reload", sessionId?: string): Promise<void> {
	// 页面进程停了的那一页，`loadedBrowser` 会直接报错；agent 的 reload 就是人点的刷新，绕过它重新加载。
	const stopped = tabs.get(id);
	if (step === "reload" && stopped?.contents && !stopped.contents.isDestroyed() && stopped.contents.isCrashed()) {
		const contents = browserContents(id, sessionId);
		stopped.state.failure = undefined;
		stopped.documentReady = false;
		contents.reload();
		await loadedBrowser(id, sessionId);
		return;
	}
	const contents = await loadedBrowser(id, sessionId);
	const tab = tabs.get(id);
	const history = contents.navigationHistory;
	if (step === "back" && !history.canGoBack()) throw new Error("没有上一页可以后退");
	if (step === "forward" && !history.canGoForward()) throw new Error("没有下一页可以前进");
	let timer: NodeJS.Timeout | undefined;
	let landed = () => {};
	const events = ["did-navigate", "did-navigate-in-page", "did-fail-load", "destroyed"] as const;
	try {
		await Promise.race([
			new Promise<void>((resolve) => {
				landed = () => resolve();
				if (tab) tab.wake = landed;
				for (const name of events) contents.on(name as "did-navigate", landed);
				if (step === "back") history.goBack();
				else if (step === "forward") history.goForward();
				else contents.reload();
			}),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(NOT_LOADED)), 30_000); }),
		]);
	} finally {
		clearTimeout(timer);
		if (tab) tab.wake = undefined;
		if (!contents.isDestroyed()) for (const name of events) contents.off(name as "did-navigate", landed);
	}
	await loadedBrowser(id, sessionId);
}
function refresh(tab: Tab): void {
	const contents = tab.contents;
	if (!contents) return;
	if (contents.isDestroyed()) return;
	// 刚挂上、第一个响应还没回来时 guest 的地址是空的，地址栏照旧写着要去的那一页。
	tab.state = { ...tab.state, title: contents.getTitle(), url: contents.getURL() || tab.state.url, loading: contents.isLoading(),
		canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
	publish();
}

/**
 * Load a page into this conversation's current tab, or into a new one.
 *
 * `reveal` is whether the panel comes forward for it: for whoever opens a page — the address bar, a
 * bookmark, a preview link, an agent's `browser_open` — so the page is seen where it opened. Never for
 * what an agent does in a page afterwards (`selectBrowser`): that once pulled the panel over the
 * conversation on every click, straight after it had been closed. Pages load and run the same either
 * way — the panel is kept mounted while closed, see `DockView`.
 */
export async function openBrowser(url: string, sessionId: string | null, newTab = false, reveal = true): Promise<string> {
	const location = browserUrl(url);
	const current = tabs.get(activeBySession.get(sessionKey(sessionId)) ?? "");
	/*
	 * A new tab for a page this conversation already has open is the same page twice. Pressing a
	 * preview's 「在侧栏中打开」 again while the panel was still coming up gave two identical tabs, and
	 * an agent checking its page after every edit gave one per check, all counting towards the limit
	 * below. That tab is loaded again instead — a local page's copy has a fixed address and may have
	 * just been rewritten. Not `about:blank`: that is the 「+」 button, and two empty tabs are asked for.
	 */
	const twin = newTab && location !== "about:blank" ? [...tabs.values()].find((tab) => tab.state.sessionId === sessionId && tab.state.url === location) : undefined;
	const existing = twin ?? (!newTab && current?.state.sessionId === sessionId ? current : undefined);
	if (existing) return loadInto(existing, location, reveal);
	if (tabs.size >= 20) throw new Error("最多打开 20 个标签，请先关闭不用的页面");
	const id = randomUUID();
	let resolve!: (contents: WebContents) => void;
	let reject!: (error: Error) => void;
	const ready = new Promise<WebContents>((done, fail) => { resolve = done; reject = fail; });
	// A closed pending tab may have no waiter after an open timeout.
	void ready.catch(() => {});
	const tab: Tab = { resolve, reject, ready, state: { id, sessionId, url: location, title: "新标签页", loading: true, canGoBack: false, canGoForward: false, zoom: browserZoom(preferences().defaultZoom ?? 1), viewport: null, wanted: true } };
	tabs.set(id, tab);
	selectTab(tab);
	publish(reveal);
	await readyBrowser(tab);
	return id;
}

async function loadInto(tab: Tab, location: string, reveal: boolean): Promise<string> {
	tab.state.error = undefined;
	tab.state.url = location;
	// `wanted`, because this tab may be asleep: nothing mounts it while its conversation is off
	// screen, and `readyBrowser` below would wait out its full timeout for a page nobody built.
	tab.state.wanted = true;
	selectTab(tab);
	publish(reveal);
	const contents = await readyBrowser(tab);
	/*
	 * 不等 `loadURL` 的结果：站点不回应时它可以一直不了结，人在地址栏回车、agent 开页都跟着挂住。
	 * 失败由 `did-fail-load` 写进 `tab.state.failure`，等文档的是 `loadedBrowser`，它有时限。
	 */
	tab.documentReady = false;
	void contents.loadURL(location).catch(() => {});
	return tab.state.id;
}

async function readyBrowser(tab: Tab): Promise<WebContents> {
	let timer: NodeJS.Timeout | undefined;
	try {
		if (tab.contents && !tab.contents.isDestroyed()) return tab.contents;
		return await Promise.race([tab.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("浏览器面板没有在 30 秒内就绪")), 30_000); })]);
	} finally { clearTimeout(timer); }
}

/** Only the main app may attach one of its sandboxed guests to a tab. */
export function attachBrowser(id: string, contentsId: number, sender: WebContents): void {
	const tab = tabs.get(id);
	const contents = webContents.fromId(contentsId);
	if (!tab || !contents || contents.getType() !== "webview" || contents.hostWebContents !== sender) throw new Error("无效的浏览器页面");
	if (tab.contents === contents) return;
	if (tab.contents && !tab.contents.isDestroyed()) throw new Error("标签已经连接另一个页面");
	tab.contents = contents;
	// The page exists; from here the panel decides on its own how long to keep it.
	tab.state.wanted = undefined;
	// 挂上时页面多半还在等第一个响应（`BrowserPage` 在 `did-attach` 就来报到）；已经加载完的才算现成。
	tab.documentReady = !contents.isLoadingMainFrame();
	contents.on("did-start-navigation", (details) => {
		if (!details.isMainFrame || details.isSameDocument) return;
		tab.documentReady = false;
		// 又在加载一张文档了：上一次的失败不再是这一页的样子。
		tab.state.failure = undefined;
	});
	contents.on("dom-ready", () => { tab.documentReady = true; });
	contents.on("did-start-loading", () => refresh(tab));
	contents.on("did-stop-loading", () => { tab.documentReady = true; refresh(tab); });
	contents.on("did-navigate", () => refresh(tab));
	contents.on("did-navigate-in-page", () => refresh(tab));
	contents.on("page-title-updated", () => refresh(tab));
	contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
		if (code !== -3 && mainFrame) { tab.state.failure = { kind: "load", detail: description }; refresh(tab); }
	});
	/*
	 * 页面进程没了（崩溃、内存不够被系统杀掉）：自动重新加载一次，回到原来那一页。15 秒内又没了就不再重来，
	 * 停在错误上等人点刷新——一页一加载就崩的，自动重来只会无休止地崩下去。
	 */
	contents.on("render-process-gone", (_event, detail) => {
		tab.documentReady = false;
		// 新的页面进程不带旧的设备仿真：不管下一张文档是自动重来、人点刷新还是 agent 换页，都要再落一次。
		contents.once("dom-ready", () => applyView(tab));
		const now = Date.now();
		if (now - (tab.crashedAt ?? 0) > 15_000) {
			tab.crashedAt = now;
			contents.reload();
		} else {
			tab.state.failure = { kind: "crash", detail: detail.reason };
			// 等着这一页的 agent 不必等满时限：`loadedBrowser` 醒来就认出它崩了。
			tab.wake?.();
		}
		publish();
	});
	contents.on("will-navigate", (event, next) => {
		try { browserUrl(next); } catch { event.preventDefault(); }
	});
	contents.on("will-redirect", (event, next) => {
		try { browserUrl(next); } catch { event.preventDefault(); }
	});
	// A page opening a window is not a person asking to look — least of all a page an agent is clicking through.
	contents.setWindowOpenHandler(({ url: next }) => {
		void openBrowser(next, tab.state.sessionId, true, false).catch((error: unknown) => { tab.state.error = String(error); publish(); });
		return { action: "deny" };
	});
	// 离开页面提示被取消时留在这一页：旧文档照旧能读，等着换页的那一方不必等满时限。
	watchDialogs(contents, () => tab.state.sessionId, () => { tab.documentReady = true; tab.wake?.(); });
	contents.setZoomFactor(tab.state.zoom);
	// 挂上时第一页还没提交的话，Chromium 提交时按源换上那个源的缩放，刚设的就没了；等它能读了再设一次。
	if (!tab.documentReady) contents.once("dom-ready", () => applyView(tab));
	contents.once("destroyed", () => {
		if (!tabs.has(id)) return;
		tab.contents = undefined;
		tab.documentReady = false;
		tab.ready = new Promise<WebContents>((resolve, reject) => { tab.resolve = resolve; tab.reject = reject; });
		void tab.ready.catch(() => {});
	});
	fitViewport(tab);
	refresh(tab);
	tab.resolve(contents);
}

export async function browserCommand(command: BrowserCommand): Promise<BrowserState> {
	if (command.type === "open") {
		const url = browserLocalPage(command.url) ? await openLocalPage(command.url, command.sessionId) : command.url;
		await openBrowser(url, command.sessionId, command.newTab);
		return browserState();
	}
	if (command.type === "close") { closeBrowser(command.id); return browserState(); }
	const tab = tabs.get(command.id);
	// A ResizeObserver notification may arrive after the user closed its guest.
	if (!tab && command.type === "resize") return browserState();
	if (!tab) throw new BrowserTabClosed();
	// 地址栏是某一个网页的：右栏里每个网页一个标签，「这个会话当前那一页」不一定是正在打字的这一页。
	if (command.type === "navigate") {
		const url = browserLocalPage(command.url) ? await openLocalPage(command.url, tab.state.sessionId) : command.url;
		// 加载失败不在这里报：`did-fail-load` 已写进 `tab.state.failure`，面板上盖着的那一层就是它，见 `loadInto`。
		await loadInto(tab, url, false);
		return browserState();
	}
	if (command.type === "resize") {
		if (!Number.isFinite(command.width) || !Number.isFinite(command.height) || command.width <= 0 || command.height <= 0) throw new Error("无效的页面尺寸");
		tab.size = { width: command.width, height: command.height }; fitViewport(tab); return browserState();
	}
	const contents = await awakeBrowser(command.id);
	switch (command.type) {
		// From the renderer, which means a person picked it.
		case "select": await selectBrowser(command.id, true); break;
		case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
		case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
		case "reload": tab.state.error = undefined; tab.state.failure = undefined; contents.reload(); break;
		case "devtools": contents.openDevTools({ mode: "detach" }); break;
		// 加载失败时页面停在 Chromium 的错误页上，地址栏记着的那个才是要去的。
		case "external": await openOutside([contents.getURL(), tab.state.url]); break;
		case "zoom": tab.state.zoom = browserZoom(command.factor); applyView(tab); break;
		case "viewport": {
			tab.state.viewport = browserViewport(command.viewport);
			fitViewport(tab);
			break;
		}
		default: throw new Error("未知浏览器操作");
	}
	publish();
	return browserState();
}
/**
 * Make a tab its conversation's current one.
 *
 * `reveal` as in `openBrowser`. An agent selects a tab before every action it takes in it, so this
 * is the path that brought a closed panel back on each click.
 */
export async function selectBrowser(id: string, reveal: boolean): Promise<void> {
	const tab = tabs.get(id);
	if (!tab) throw new BrowserTabClosed();
	await awakeBrowser(id);
	selectTab(tab);
	// Chromium shares zoom by origin; restore this tab's preference when bringing it forward.
	applyView(tab);
	publish(reveal);
}

/** Pointer coordinates belong to the tab, so navigation and page top layers cannot erase them. */
export function pointBrowser(id: string, point: Omit<BrowserPointer, "sequence">): void {
	const tab = tabs.get(id);
	if (!tab) throw new BrowserTabClosed();
	tab.state.pointer = { ...point, sequence: (tab.state.pointer?.sequence ?? 0) + 1 };
	publish();
}
function closeBrowser(id: string): void {
	const tab = tabs.get(id);
	if (!tab) return;
	tabs.delete(id);
	// The conversation falls back to its own remaining tab, not to whatever tab is newest overall.
	const key = sessionKey(tab.state.sessionId);
	if (activeBySession.get(key) === id) {
		const fallback = [...tabs.values()].findLast((entry) => sessionKey(entry.state.sessionId) === key);
		if (fallback) activeBySession.set(key, fallback.state.id);
		else activeBySession.delete(key);
	}
	if (activeId === id) activeId = [...tabs.keys()].at(-1) ?? null;
	if (tab.contents && !tab.contents.isDestroyed()) tab.contents.close();
	else tab.reject(new BrowserTabClosed());
	publish();
}
export function closeSessionBrowser(sessionId: string): void {
	for (const tab of tabs.values()) if (tab.state.sessionId === sessionId) closeBrowser(tab.state.id);
}

/**
 * 这一页的缩放与视口落到页面上。
 *
 * 页面进程崩溃了就不碰：对崩溃的 guest 调设备仿真，主进程当场段错误、整个应用退出（Electron 44.7 实测；
 * 崩溃后面板多出一行错误、页面被挤矮，`resize` 就会走到这里）。恢复后由 `dom-ready` 再落一次。
 */
function applyView(tab: Tab): void {
	const contents = tab.contents;
	if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
	contents.setZoomFactor(tab.state.zoom);
	fitViewport(tab);
}
function fitViewport(tab: Tab): void {
	const contents = tab.contents;
	// 崩溃的不碰，见 `applyView`。
	if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
	const viewport = tab.state.viewport;
	tab.scale = viewport && tab.size ? Math.min(1, tab.size.width / viewport.width, tab.size.height / viewport.height) : 1;
	if (viewport) contents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: viewport, viewSize: viewport, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, scale: tab.scale });
	else contents.disableDeviceEmulation();
}
export function browserScale(id: string): number { return tabs.get(id)?.scale ?? 1; }

/**
 * A capture flattened onto white — the canvas any browser draws under a page.
 *
 * A guest paints nothing where its page sets no background; on screen the `<webview>`'s white shows
 * through, but a capture is of the guest alone. On a page with no background of its own, 98% of what
 * `capturePage` returned was transparent: black once a thumbnail was made a JPEG, and a backdrop the
 * model could only guess at behind a screenshot's text — whose antialiased edges are themselves
 * half-transparent. Done on the pixels rather than by giving the page a background, so what an agent
 * reads from the page, its computed styles included, stays the page's own.
 *
 * `toBitmap` is premultiplied, so the white that shows through is added to each channel as it is;
 * clamped all the same, since the layout is the platform's to choose. The pixel size is read off the
 * buffer, because which of pixels or points `getSize` reports is not something the API promises.
 */
export function onWhite(image: NativeImage): NativeImage {
	const scaleFactor = Math.max(1, ...image.getScaleFactors());
	const size = image.getSize(scaleFactor);
	const pixels = image.toBitmap({ scaleFactor });
	const scale = Math.round(Math.sqrt(pixels.length / 4 / Math.max(1, size.width * size.height))) || 1;
	const width = size.width * scale;
	const height = size.height * scale;
	if (width * height * 4 !== pixels.length) return image;
	let clear = false;
	for (let alpha = 3; alpha < pixels.length; alpha += 4) {
		const through = 255 - pixels[alpha];
		if (through === 0) continue;
		clear = true;
		pixels[alpha - 3] = Math.min(255, pixels[alpha - 3] + through);
		pixels[alpha - 2] = Math.min(255, pixels[alpha - 2] + through);
		pixels[alpha - 1] = Math.min(255, pixels[alpha - 1] + through);
		pixels[alpha] = 255;
	}
	return clear ? nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: scale }) : image;
}
