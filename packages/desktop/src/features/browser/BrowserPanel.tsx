import { commitDraft, isLegalDraft } from "../../lib/number-draft.ts";
import { useI18n } from "../../i18n/index.ts";
import { ArrowLeft, ArrowRight, Bookmark, Check, ChevronLeft, ChevronRight, CodeXml, Ellipsis, Globe, Minus, MousePointer2, Plus, RotateCw, Scan, TriangleAlert, WifiOff, X } from "../../ui/icons/index.ts";
import { useEffect, useRef, useState } from "react";
import { useDockScope, usePanelKind, useScopedSessionId } from "../../app/session-scope.tsx";
import type { BrowserCommand, BrowserSelection } from "../../../shared/browser.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { Input } from "../../ui/inputs/NativeField.tsx";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Popover, MenuBody, MenuItem, MenuSeparator, usePopover } from "../../ui/overlay/Popover.tsx";
import { AddressBar } from "./AddressBar.tsx";
import { BrowserPage } from "./BrowserPage.tsx";
import { BrowserSelectionCard } from "./BrowserSelectionCard.tsx";
import { browserVisited, closeBrowserTab, commandBrowser, dropBrowserTab, useBrowser, useBrowserHosted } from "./browser-store.ts";
import { panelInstance } from "../../lib/panel-instance.ts";

const VIEW_W = { min: 240, max: 3840, step: 1 };
const VIEW_H = { min: 240, max: 2160, step: 1 };

/**
 * 网页标签上写这一页的标题；空白页和还没有标题的页是「新标签页」。
 *
 * 没有 `<title>` 的页面，Chromium 报上来的标题就是地址本身——空白页于是写着「about:blank」。
 */
export function BrowserTabTitle({ kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const { t } = useI18n();
	const id = panelInstance(kind);
	const tab = useBrowser((state) => state.tabs.find((entry) => entry.id === id));
	if (!tab) return <>{fallback}</>;
	return <>{tab.url === "about:blank" || !tab.title || tab.title === "about:blank" ? t("browser.newTab") : tab.title}</>;
}

/**
 * 一个网页：右栏的一个标签就是一页，`browser:<网页 id>`。
 *
 * 页面上的 `<webview>` 只在这一屏托管这一页时才挂（`useBrowserHosted`）——同一页在两处各挂一个，就是
 * 两个页面。网页没了（agent 关了它、会话删了、重启之后存盘的布局里还记着它），这一格自己退下。
 */
export function BrowserPanel() {
	const { t } = useI18n();
	const all = useBrowser((state) => state.tabs);
	const loaded = useBrowser((state) => state.loaded);
	const scope = useDockScope();
	const kind = usePanelKind();
	const sessionId = useScopedSessionId();
	const id = kind ? panelInstance(kind) : null;
	const tab = all.find((entry) => entry.id === id);
	const hosted = useBrowserHosted(scope, id);
	useEffect(() => { browserVisited(sessionId); }, [sessionId]);
	useEffect(() => {
		if (loaded && !tab && scope && kind) dropBrowserTab(scope, kind);
	}, [loaded, tab, scope, kind]);
	const settings = useApp((state) => state.settings);
	const saveSettings = useApp((state) => state.saveSettings);
	const addressInput = useRef<HTMLInputElement>(null);
	const [selection, setSelection] = useState<BrowserSelection | null>(null);
	const [inspecting, setInspecting] = useState<string | null>(null);
	const inspection = useRef({ generation: 0, id: "" });
	const [width, setWidth] = useState("1440"), [height, setHeight] = useState("900");
	useEffect(() => () => { inspection.current.generation++; if (inspection.current.id) void bridge.browser.cancelInspect(inspection.current.id).catch(() => {}); }, [tab?.id, tab?.url]);
	const options = usePopover();
	const [menu, setMenu] = useState<"actions" | "bookmarks" | "viewport">("actions");
	const blank = !tab || tab.url === "about:blank";
	useEffect(() => { setSelection(null); setInspecting(null); }, [tab?.id, tab?.url]);
	const command = (type: "back" | "forward" | "reload" | "devtools") => { if (tab) void commandBrowser({ type, id: tab.id }); };
	const go = (url: string) => { if (tab) void commandBrowser({ type: "navigate", id: tab.id, url }); };
	const open = (url: string) => void commandBrowser({ type: "open", url, sessionId, newTab: true });
	const mark = async () => {
		if (!tab || !settings) return;
		const list = settings.browser?.bookmarks ?? [];
		await saveSettings({ ...settings, browser: { ...settings.browser, bookmarks: list.some((entry) => entry.url === tab.url) ? list.filter((entry) => entry.url !== tab.url) : [...list, { url: tab.url, title: tab.title || tab.url }] } });
	};
	const inspect = async (mode: "element" | "region") => {
		if (!tab) return;
		const generation = ++inspection.current.generation; inspection.current.id = tab.id;
		setInspecting(tab.id);
		try { const result = await bridge.browser.inspect(tab.id, mode); if (generation === inspection.current.generation) setSelection(result); }
		catch (error) { useApp.getState().notify(String(error), "error"); }
		finally { if (generation === inspection.current.generation) { setInspecting(null); inspection.current.id = ""; } }
	};
	const saved = settings?.browser?.bookmarks?.some((entry) => entry.url === tab?.url);
	return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-browser-panel>
		<div className="flex h-10 shrink-0 items-center gap-1 px-2" data-browser-toolbar>
			<IconButton size="sm" label={t("browser.back")} icon={<ArrowLeft size={13} />} disabled={!tab?.canGoBack} onClick={() => command("back")} />
			<IconButton size="sm" label={t("browser.forward")} icon={<ArrowRight size={13} />} disabled={!tab?.canGoForward} onClick={() => command("forward")} />
			<IconButton size="sm" label={t("common.refresh")} icon={<RotateCw size={13} className={tab?.loading ? "ly-pulse" : ""} />} disabled={!tab} onClick={() => command("reload")} />
			<AddressBar url={tab?.url ?? "about:blank"} bookmarks={settings?.browser?.bookmarks ?? []} search={settings?.browser} onOpen={go} onOutside={(typed) => { if (typed) void commandBrowser({ type: "external", url: typed }); else if (tab && !blank) void commandBrowser({ type: "external", id: tab.id }); }} inputRef={addressInput} />
			<IconButton label={t("browser.menu")} menu={options.open} data-inspecting={inspecting ? "" : undefined} onClick={(event) => { setMenu("actions"); options.toggle(event); }}
				className="aria-expanded:bg-card-hover aria-expanded:text-ink data-[inspecting]:bg-card-hover data-[inspecting]:text-ink" icon={<Ellipsis size={16} />} />
		</div>
		{inspecting && <div role="status" className="flex shrink-0 items-center justify-between px-3 py-1 text-caption text-ink-muted">
			<span>{t("browser.pickOnPage")}</span><IconButton size="sm" label={t("browser.exitInspect")} icon={<X size={12} />} onClick={() => void bridge.browser.cancelInspect(inspecting)} />
		</div>}
		{tab?.error && <p role="status" className="px-3 py-2 text-detail text-danger">{tab.error}</p>}
		<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-shell">
			{tab && hosted && <BrowserPage tab={tab} />}
			{/* 标题就够了：地址栏就在正上方，说明它怎么用的那一句和那枚跳过去的按钮都是在解释一个不需要解释的东西。 */}
			{blank && <div className="absolute inset-0 flex flex-col bg-shell" data-browser-empty><PanelEmpty icon={Globe} title={t("browser.openPage")} /></div>}
			{/* 盖在页面上而不是插在它上面：插一行字会把页面挤矮，页面进程已经停了的时候，那次改尺寸曾带走整个应用。 */}
			{tab?.failure && <div className="absolute inset-0 flex flex-col bg-shell" data-browser-failure={tab.failure.kind}>
				<PanelEmpty icon={tab.failure.kind === "crash" ? TriangleAlert : WifiOff} title={t(tab.failure.kind === "crash" ? "browser.pageStopped" : "browser.loadFailed")}>
					<span className="block break-all">{tab.failure.detail}</span>
					<span className="mt-4 block"><Button icon={<RotateCw size={13} />} onClick={() => command("reload")}>{t("browser.reloadPage")}</Button></span>
				</PanelEmpty>
			</div>}
		</div>
		{selection && <BrowserSelectionCard selection={selection} onClose={() => setSelection(null)} />}
		{options.open && <Popover anchor={options.anchor} onClose={options.close} placement="bottom" width="default" maxHeight={340} label={t("browser.menu")}
			header={menu !== "actions" && <button type="button" onClick={() => setMenu("actions")} className="flex h-9 w-full items-center gap-2 px-3 text-detail text-ink-muted hover:text-ink"><ChevronLeft size={13} aria-hidden />{t(menu === "bookmarks" ? "browser.bookmarks" : "browser.viewport")}</button>}
			footer={menu === "viewport" && tab && <form className="flex items-center gap-1.5 p-2" onSubmit={(event) => { event.preventDefault(); const nextWidth = commitDraft(width, VIEW_W); const nextHeight = commitDraft(height, VIEW_H); if (nextWidth === null || nextHeight === null) return; void commandBrowser({ type: "viewport", id: tab.id, viewport: { width: nextWidth, height: nextHeight } }); options.close(); }}>
				<Input aria-label={t("browser.viewportWidth")} type="text" inputMode="numeric" required value={width} onChange={(event) => { if (isLegalDraft(event.target.value, VIEW_W)) setWidth(event.target.value); }} className="ly-field ly-field-compact min-w-0 flex-1 text-center tabular-nums" />×
				<Input aria-label={t("browser.viewportHeight")} type="text" inputMode="numeric" required value={height} onChange={(event) => { if (isLegalDraft(event.target.value, VIEW_H)) setHeight(event.target.value); }} className="ly-field ly-field-compact min-w-0 flex-1 text-center tabular-nums" />
				<Button type="submit" variant="subtle" size="sm" label={t("browser.apply")} icon={<Check size={13} strokeWidth={2.2} aria-hidden />} />
			</form>}>
			<MenuBody>
				{menu === "actions" && <>
					<MenuItem icon={<Plus size={14} />} onClick={() => { open("about:blank"); options.close(); }}>{t("browser.newTab")}</MenuItem>
					<MenuItem icon={<X size={14} />} disabled={!scope || !kind} onClick={() => { if (scope && kind) closeBrowserTab(scope, kind); options.close(); }}>{t("browser.closeTab")}</MenuItem>
					<MenuItem icon={<Bookmark size={14} fill={saved ? "currentColor" : "none"} />} disabled={blank} onClick={() => { void mark(); options.close(); }}>{t(saved ? "browser.unbookmark" : "browser.bookmark")}</MenuItem>
					<MenuItem icon={<Bookmark size={14} />} trailing={<ChevronRight size={13} />} onClick={() => setMenu("bookmarks")}>{t("browser.bookmarks")}</MenuItem>
					<MenuSeparator />
					<MenuItem icon={<MousePointer2 size={14} />} disabled={blank} onClick={() => { options.close(); if (inspecting) void bridge.browser.cancelInspect(inspecting); else void inspect("element"); }}>{t(inspecting ? "browser.exitInspect" : "browser.inspectElement")}</MenuItem>
					<MenuItem icon={<Scan size={14} />} disabled={blank} onClick={() => { options.close(); void inspect("region"); }}>{t("browser.selectRegion")}</MenuItem>
					<MenuItem icon={<CodeXml size={14} />} disabled={blank} onClick={() => { command("devtools"); options.close(); }}>{t("browser.devtools")}</MenuItem>
					<MenuSeparator />
					<div className="flex h-8 items-center gap-1 px-2 text-label text-ink-muted">
						<span className="flex-1">{t("browser.zoomLabel")}</span>
						<IconButton size="sm" label={t("browser.zoomOut")} icon={<Minus size={13} />} disabled={!tab || tab.zoom <= 0.25} onClick={() => { if (tab) void commandBrowser({ type: "zoom", id: tab.id, factor: Math.max(0.25, Math.round((tab.zoom - 0.25) * 100) / 100) }); }} />
						<button type="button" aria-label={t("browser.zoomReset")} disabled={!tab} onClick={() => { if (tab) void commandBrowser({ type: "zoom", id: tab.id, factor: 1 }); }} className="h-6 w-11 rounded-lg text-detail tabular-nums hover:bg-card-hover disabled:opacity-40">{Math.round((tab?.zoom ?? 1) * 100)}%</button>
						<IconButton size="sm" label={t("browser.zoomIn")} icon={<Plus size={13} />} disabled={!tab || tab.zoom >= 3} onClick={() => { if (tab) void commandBrowser({ type: "zoom", id: tab.id, factor: Math.min(3, Math.round((tab.zoom + 0.25) * 100) / 100) }); }} />
					</div>
					<MenuItem icon={<Scan size={14} />} disabled={!tab} hint={tab?.viewport ? `${tab.viewport.width} × ${tab.viewport.height}` : t("browser.fit")} trailing={<ChevronRight size={13} />} onClick={() => { setWidth(String(tab?.viewport?.width ?? 1440)); setHeight(String(tab?.viewport?.height ?? 900)); setMenu("viewport"); }}>{t("browser.viewport")}</MenuItem>
				</>}
				{menu === "viewport" && tab && [{ label: t("browser.fitWindow"), viewport: null }, { label: t("browser.phonePreset"), viewport: { width: 390, height: 844 } }, { label: t("browser.tabletPreset"), viewport: { width: 768, height: 1024 } }, { label: t("browser.desktopPreset"), viewport: { width: 1440, height: 900 } }].map((preset) => <MenuItem key={preset.label} selected={tab.viewport?.width === preset.viewport?.width && tab.viewport?.height === preset.viewport?.height} onClick={() => { void commandBrowser({ type: "viewport", id: tab.id, viewport: preset.viewport } satisfies BrowserCommand); options.close(); }}>{preset.label}</MenuItem>)}
				{menu === "bookmarks" && (settings?.browser?.bookmarks?.length ? settings.browser.bookmarks.map((entry) => <MenuItem key={entry.url} detail={entry.url} onClick={() => { open(entry.url); options.close(); }}>{entry.title}</MenuItem>) : <p className="px-2 py-4 text-center text-detail text-ink-faint">{t("browser.noBookmarks")}</p>)}
			</MenuBody>
		</Popover>}
	</div>;
}
