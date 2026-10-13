import { readLocalPageFor, type Tool, type ToolResult } from "@plume/core";
import { browserLocalPage, type BrowserResultDetails } from "../shared/browser.ts";
import { localPagePath, localPageUrl } from "./local-page.ts";
import { actBrowser, captureBrowser, readBrowser, type BrowserAction } from "./browser-actions.ts";
import { answeringDialogs, describeDialogs } from "./browser-dialogs.ts";
import { nativeText } from "./i18n.ts";
import { browserContents, browserCommand, browserState, closeSessionBrowser, loadedBrowser, onWhite, openBrowser, selectBrowser } from "./browser-workspace.ts";

function result(value: unknown, details: BrowserResultDetails = { kind: "browser" }): ToolResult {
	return { content: [{ type: "text", text: `<browser-data untrusted="true">\n${JSON.stringify(value, null, 2)}\n</browser-data>` }], details };
}

/**
 * What the conversation's card for this tab should say after a call — see `BrowserResultDetails`.
 *
 * Best effort: nothing here may turn an action that worked into a tool call that failed.
 */
function view(id: string, opened = false): BrowserResultDetails {
	const details: BrowserResultDetails = { kind: "browser", tabId: id, ...(opened ? { opened } : {}) };
	try {
		const contents = browserContents(id);
		details.url = contents.getURL();
		details.title = contents.getTitle();
	} catch {
		// The tab closed under us: the card says what is known.
	}
	return details;
}
function fail(error: unknown): ToolResult {
	return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}
const ACTIONS = ["click", "type", "links", "eval", "read", "scroll", "press", "hover", "back", "forward", "reload", "wait"] as const;
function actionName(value: unknown): value is BrowserAction["action"] { return ACTIONS.some((name) => name === value); }
const DIALOG = { type: "string", enum: ["accept", "dismiss"], description: "How to answer a confirm or leave-page prompt the page raises during this call. Default dismiss; alerts are always acknowledged." };

/**
 * All tools operate the same tabs as the user, scoped by the trusted runtime context.
 *
 * Only `browser_open` brings the panel forward, so the person sees the page the agent went to; the
 * clicks and typing after it do not — see `openBrowser` for what that once did.
 */
export function createBrowserTools(): { tools: Tool[]; dispose: () => void } {
	const owners = new Set<string>();
	// Awaited, not asserted: this session's tab may be asleep because the user is looking elsewhere,
	// and an agent's own tab has to come back rather than report itself closed.
	const current = async (id: unknown, sessionId: string) => {
		const tab = typeof id === "string" ? browserState().tabs.find((entry) => entry.id === id) : browserState().tabs.find((entry) => entry.id === browserState().activeId && entry.sessionId === sessionId) ?? browserState().tabs.findLast((entry) => entry.sessionId === sessionId);
		if (!tab) throw new Error("先调用 browser_open 打开一个页面");
		await loadedBrowser(tab.id, sessionId);
		return tab.id;
	};
	const tools: Tool[] = [
		{
			name: "browser_open", executionMode: "sequential", mutating: true,
			description: "Open an http(s) URL or a Plume preview in the built-in browser beside the conversation; returns tabId, the rendered text and interactive elements. " +
				"Reuses this session's selected tab unless newTab; a page already open here is reloaded in its own tab. " +
				"A local .html file opens by path as a copy of that one file — open it again after changing it; never start a server for it. " +
				"To look at a page you wrote, use preview with its path and check: true instead. This tool is for pages you need to click through or type into.",
			parameters: { type: "object", properties: { url: { type: "string" }, newTab: { type: "boolean" }, dialog: DIALOG }, required: ["url"], additionalProperties: false },
			async execute(args, ctx) {
				try {
					if (typeof args.url !== "string") throw new Error("url 必须是地址文本");
					let target = args.url;
					// No scheme and an .html name never parsed as a URL anyway, so reading it as a path takes nothing away.
					if (browserLocalPage(target) || (!/^[a-z][\w+.-]*:/i.test(target) && /\.html?$/i.test(target.trim()))) {
						const page = await readLocalPageFor(ctx, localPagePath(target));
						if ("error" in page) throw new Error(page.error);
						target = await localPageUrl(page.content, page.absolute, ctx.sessionId);
					}
					const url = new URL(target);
					if (!["http:", "https:", "ly-preview:"].includes(url.protocol)) throw new Error("只允许网页和本地预览地址");
					if (ctx.requestApproval && url.protocol !== "ly-preview:") {
						const approval = await ctx.requestApproval({ kind: "network", title: `打开 ${url.host}`, detail: url.href, subject: url.origin });
						if (approval === "reject") throw new Error("用户拒绝这次访问");
					}
					owners.add(ctx.sessionId);
					const id = await openBrowser(url.href, ctx.sessionId, args.newTab === true);
					await loadedBrowser(id, ctx.sessionId);
					// 打不开的站点交回来的是 Chromium 的空白错误页：读它什么也看不出，直接说没打开、为什么。
					const failure = browserState().tabs.find((entry) => entry.id === id)?.failure;
					if (failure?.kind === "load") throw new Error(nativeText("browser.notOpened", { detail: failure.detail, url: url.href }));
					const page = await readBrowser(id);
					return result({ tabId: id, page }, view(id, true));
				} catch (error) { return fail(error); }
			},
		},
		{
			name: "browser_act", executionMode: "sequential", mutating: true,
			description: "Operate this session's tab. click/type/hover take a ref from read (such as e12), or else a CSS selector seen in the current page, and wait up to 3s for the element to be visible, enabled and not covered; type replaces the field's value; scroll takes x/y pixel deltas; press, a named key; eval, a JavaScript expression; " +
				"wait, until text appears, selector is visible or expression is truthy (timeout ms, default 10000, at most 30000), across navigations; back/forward/reload wait for the page and return it as read does. Verify with read, wait or screenshot, not fixed sleeps.",
			parameters: { type: "object", properties: { action: { type: "string", enum: [...ACTIONS] }, tabId: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, expression: { type: "string" }, x: { type: "number" }, y: { type: "number" }, timeout: { type: "number" }, dialog: DIALOG }, required: ["action"], additionalProperties: false },
			async execute(args, ctx) {
				try {
					if (!actionName(args.action)) throw new Error("未知浏览器操作");
					const action: BrowserAction = { action: args.action };
					if (args.ref !== undefined) { if (typeof args.ref !== "string" || !/^e\d+$/.test(args.ref)) throw new Error(nativeText("browser.badRef")); action.ref = args.ref; }
					for (const name of ["selector", "text", "expression"] as const) { const value = args[name]; if (value !== undefined) { if (typeof value !== "string") throw new Error(`${name} 必须是文本`); action[name] = value; } }
					for (const name of ["x", "y", "timeout"] as const) { const value = args[name]; if (value !== undefined) { if (typeof value !== "number") throw new Error(`${name} 必须是数字`); action[name] = value; } }
					const id = await current(args.tabId, ctx.sessionId);
					const outcome = await actBrowser(id, action, ctx.sessionId);
					return result(outcome, view(id));
				} catch (error) { return fail(error); }
			},
		},
		{
			name: "browser_tabs", executionMode: "sequential", mutating: true,
			description: "List this session's browser tabs, or select/close one by tabId.",
			parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "select", "close"] }, tabId: { type: "string" } }, required: ["action"], additionalProperties: false },
			async execute(args, ctx) {
				try {
					if (args.action === "select") await selectBrowser(await current(args.tabId, ctx.sessionId), false);
					else if (args.action === "close") await browserCommand({ type: "close", id: await current(args.tabId, ctx.sessionId) });
					else if (args.action !== "list") throw new Error("未知标签操作");
					return result(browserState().tabs.filter((entry) => entry.sessionId === ctx.sessionId));
				} catch (error) { return fail(error); }
			},
		},
		{
			name: "browser_viewport", executionMode: "sequential", mutating: true,
			description: "Set zoom (0.25–3) and/or width and height in CSS pixels (240–3840 × 240–2160); reset restores the panel's viewport. Returns innerWidth, innerHeight and devicePixelRatio.",
			parameters: { type: "object", properties: { tabId: { type: "string" }, zoom: { type: "number" }, width: { type: "number" }, height: { type: "number" }, reset: { type: "boolean" } }, additionalProperties: false },
			async execute(args, ctx) {
				try {
					const id = await current(args.tabId, ctx.sessionId);
					if (typeof args.zoom === "number") await browserCommand({ type: "zoom", id, factor: args.zoom });
					if (args.reset === true) await browserCommand({ type: "viewport", id, viewport: null });
					else if (args.width !== undefined || args.height !== undefined) {
						if (typeof args.width !== "number" || typeof args.height !== "number") throw new Error("width 和 height 必须一起提供");
						await browserCommand({ type: "viewport", id, viewport: { width: args.width, height: args.height } });
					}
					return result(await actBrowser(id, { action: "eval", expression: "({width:innerWidth,height:innerHeight,devicePixelRatio})" }, ctx.sessionId), view(id));
				} catch (error) { return fail(error); }
			},
		},
		{
			name: "browser_screenshot", executionMode: "sequential",
			description: "Capture what this session's tab shows at its current scroll position and viewport, as a PNG one pixel per CSS pixel.",
			parameters: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
			async execute(args, ctx) {
				try {
					const id = await current(args.tabId, ctx.sessionId);
					const contents = browserContents(id, ctx.sessionId);
					// On white, as the page appears in any browser — see `onWhite` for what came back without it.
					return { content: [{ type: "image", data: onWhite(await captureBrowser(contents)).toPNG().toString("base64"), mimeType: "image/png" }], details: view(id) };
				} catch (error) { return fail(error); }
			},
		},
	];
	// 页面在调用期间弹出的对话框由这里应答，并写进结果，见 `browser-dialogs.ts`。
	const answered = tools.map((tool): Tool => ({ ...tool, async execute(args, ctx) {
		const { value, met } = await answeringDialogs(ctx.sessionId, args.dialog === "accept", () => tool.execute(args, ctx));
		return met.length === 0 ? value : { ...value, content: [...value.content, { type: "text", text: describeDialogs(met) }] };
	} }));
	return { tools: answered, dispose: () => { for (const owner of owners) closeSessionBrowser(owner); } };
}
