import { readLocalPageFor, type Tool, type ToolResult } from "@plume/core";
import { browserLocalPage, type BrowserResultDetails } from "../shared/browser.ts";
import { localPagePath, localPageUrl } from "./local-page.ts";
import { actBrowser, readBrowser, type BrowserAction } from "./browser-actions.ts";
import { awakeBrowser, browserContents, browserCommand, browserState, closeSessionBrowser, onWhite, openBrowser, selectBrowser } from "./browser-workspace.ts";

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
const ACTIONS = ["click", "type", "links", "eval", "read", "scroll", "press", "hover"] as const;
function actionName(value: unknown): value is BrowserAction["action"] { return ACTIONS.some((name) => name === value); }

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
		await awakeBrowser(tab.id, sessionId);
		return tab.id;
	};
	const tools: Tool[] = [
		{
			name: "browser_open", executionMode: "sequential", mutating: true,
			description: "Open an http(s) URL or a Plume preview in the built-in browser beside the conversation; returns tabId, the rendered text and interactive elements. " +
				"Reuses this session's selected tab unless newTab; a page already open here is reloaded in its own tab. " +
				"A local .html file opens by path as a copy of that one file — open it again after changing it; never start a server for it. " +
				"To look at a page you wrote, use preview with its path and check: true instead. This tool is for pages you need to click through or type into.",
			parameters: { type: "object", properties: { url: { type: "string" }, newTab: { type: "boolean" } }, required: ["url"], additionalProperties: false },
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
					const page = await readBrowser(id);
					return result({ tabId: id, page }, view(id, true));
				} catch (error) { return fail(error); }
			},
		},
		{
			name: "browser_act", executionMode: "sequential", mutating: true,
			description: "Operate this session's tab. click/type/hover take a CSS selector seen in the current page; type replaces the focused field's value; scroll takes x/y pixel deltas; press, a named key; eval, a JavaScript expression. Verify with read or screenshot, not fixed sleeps.",
			parameters: { type: "object", properties: { action: { type: "string", enum: [...ACTIONS] }, tabId: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, expression: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["action"], additionalProperties: false },
			async execute(args, ctx) {
				try {
					if (!actionName(args.action)) throw new Error("未知浏览器操作");
					const action: BrowserAction = { action: args.action };
					for (const name of ["selector", "text", "expression"] as const) { const value = args[name]; if (value !== undefined) { if (typeof value !== "string") throw new Error(`${name} 必须是文本`); action[name] = value; } }
					for (const name of ["x", "y"] as const) { const value = args[name]; if (value !== undefined) { if (typeof value !== "number") throw new Error(`${name} 必须是数字`); action[name] = value; } }
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
			description: "Capture this session's tab as rendered, at its current scroll position and viewport, as a PNG.",
			parameters: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
			async execute(args, ctx) {
				try {
					const id = await current(args.tabId, ctx.sessionId);
					const contents = browserContents(id, ctx.sessionId);
					// On white, as the page appears in any browser — see `onWhite` for what came back without it.
					return { content: [{ type: "image", data: onWhite(await contents.capturePage()).toPNG().toString("base64"), mimeType: "image/png" }], details: view(id) };
				} catch (error) { return fail(error); }
			},
		},
	];
	return { tools, dispose: () => { for (const owner of owners) closeSessionBrowser(owner); } };
}
