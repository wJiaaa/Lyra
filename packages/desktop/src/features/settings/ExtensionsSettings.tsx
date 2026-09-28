import { ArrowUp, Blocks, Cable, FolderOpen, MoreHorizontal, Plus, Puzzle, Sparkles, Store } from "lucide-react";
import { Caret } from "../../ui/primitives/Caret.tsx";
import { useEffect, useState } from "react";
import { Button } from "../../ui/primitives/Button.tsx";
import { useLocalScan, useMarketMarks } from "../plugins/index.ts";

import { MenuBody, MenuItem, Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { RetainedViews } from "../../ui/layout/RetainedViews.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { TabStrip } from "../../ui/primitives/TabStrip.tsx";
import { useLayout } from "../../app/layout.tsx";
import { type ExtensionsTab, useApp } from "../../store/index.ts";
import { usePluginsProject } from "./usePluginsProject.ts";
import { ProjectScope } from "./ProjectScope.tsx";
import { ExtensionHostSettings } from "./ExtensionHostSettings.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { newMcpServer } from "./mcp-defaults.ts";
import { PluginsSettings } from "./PluginsSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";
import { bridge } from "../../services/index.ts";
import { formatList, useI18n } from "../../i18n/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

type Tab = ExtensionsTab;

/** The strip's order, which is also the direction a page slides in from. */
const TAB_ORDER: readonly Tab[] = ["plugins", "mcp", "skills", "extensions"];

/**
 * 设置 › 插件：已经装上的东西，逐项管理。
 *
 * 市场（侧栏的「插件」）回答「还能装什么」，这一页回答「装了什么、开着没有、配好没有」。两页是
 * 同一件事的两半，所以标签、名字、「可更新」的判断都跟市场一致；从这里去市场是右上角那颗「插件
 * 市场」，从市场回到这里是它头上的「管理已安装」。
 *
 * 数字在标签上，因为那是这一页一眼要回答的：装了多少，各是什么。
 */
export function ExtensionsSettings() {
	const { t } = useI18n();
	const { compact } = useLayout();
	const gutter = compact ? "px-4" : "px-9";
	const workspace = usePluginsProject();
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const setView = useApp((s) => s.setView);
	const wanted = useApp((s) => s.extensionsFocus);
	const setExtensionsFocus = useApp((s) => s.setExtensionsFocus);
	const setProject = useApp((s) => s.setPluginsProject);
	const [tab, setTab] = useState<Tab>(() => useApp.getState().extensionsFocus?.tab ?? "plugins");
	const [query, setQuery] = useState(() => useApp.getState().extensionsFocus?.query ?? "");
	/* Whoever sent someone here said which tab they meant, and perhaps what to look for. Honoured
	   once and forgotten, so the next visit opens on whatever was chosen by hand rather than on
	   the last thing somebody linked to. */
	useEffect(() => {
		if (!wanted) return;
		setTab(wanted.tab);
		if (wanted.query !== undefined) setQuery(wanted.query);
		setExtensionsFocus(null);
	}, [wanted, setExtensionsFocus]);
	const [counts, setCounts] = useState({ extensions: 0 });
	const add = usePopover();
	const more = usePopover();
	const extensionsNonce = useApp((s) => s.extensionsNonce);
	const updates = useApp((s) => s.pluginUpdates);
	const [updatingAll, setUpdatingAll] = useState(false);
	// The same scan the tabs below read — one trip to the main process, not three. See `useLocalScan`.
	const { scan } = useLocalScan(workspace?.path ?? "");
	// The market's picture for each installed thing, looked up once for every tab below.
	const markOf = useMarketMarks(workspace?.path ?? "");

	/** Whichever directory this tab is about. Only 插件 and 技能 have one of their own. */
	const revealDir = (scope: "user" | "workspace") => {
		const cwd = workspace?.path ?? "";
		if (tab === "skills") return bridge.system.revealSkillsDir(scope, cwd);
		return bridge.plugins.revealDir(scope, cwd);
	};
	const hasMenu = tab === "plugins" || tab === "skills" || tab === "mcp";
	const autoUpdate = settings?.autoUpdatePlugins !== false;
	const outdated = updates?.outdated ?? [];
	const updateAll = async () => {
		setUpdatingAll(true);
		await bridge.plugins.updateAll().catch(() => undefined);
		setUpdatingAll(false);
		useApp.getState().bumpExtensions();
	};

	const addServer = (transport: "stdio" | "http") => {
		if (!settings) return;
		void saveSettings({ ...settings, mcpServers: [...settings.mcpServers, newMcpServer(transport)] });
		setTab("mcp");
	};

	/*
	 * Browsing is a different place now, not a dialog over this one.
	 *
	 * This page is for what is already installed — which bundle is on, what it brought with it,
	 * where its directory is. Finding something new is the catalogue's job, and it had been a
	 * 620px modal launched from here, which is a strange place to keep a shop. Leaving means
	 * leaving; the catalogue's own header has a gear pointing back.
	 */
	const browse = () => setView("plugins");

	useEffect(() => {
		const cwd = workspace?.path ?? "";
		// 插件和技能的数字来自上面那一次共用的扫盘；扩展读的是别处，单独问。
		void bridge.extensions
			.stats(null, cwd)
			.then((scan) => setCounts((was) => ({ ...was, extensions: scan.extensions.length })))
			.catch(() => {});
	}, [workspace?.path, settings?.disabledPlugins.length, extensionsNonce]);

	// Same order as the catalogue's tabs. They are the two halves of one subject, and a page where
	// 技能 is second and another where it is third is two orders for one list.
	const tabs: { id: Tab; label: string; count: number; icon: typeof Blocks }[] = [
		{ id: "plugins", label: t("common.plugins"), count: scan?.plugins.length ?? 0, icon: Blocks },
		{ id: "mcp", label: "MCP", count: settings?.mcpServers.length ?? 0, icon: Cable },
		{ id: "skills", label: t("common.skills"), count: scan?.skills.length ?? 0, icon: Sparkles },
		/*
		 * 扩展在最后：它不是「给模型的东西」，是「看着模型的东西」——跑在 worker 里的代码，
		 * 收事件、可以拦截。这一页答的是它有没有在跑、跑得多慢（10 §7.3）。
		 */
		{ id: "extensions", label: t("extensions.title"), count: counts.extensions, icon: Puzzle },
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-ly-extensions-page="">
			<header className={`mx-auto flex w-full max-w-[900px] shrink-0 items-start justify-between pt-2 pb-5 ${gutter}`}>
				<div className="min-w-0">
					<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("common.plugins")}</h1>
					<p className="pt-1 text-label text-ink-muted">{t("extensions.intro")}</p>
				</div>

				<div className="flex shrink-0 items-center gap-2 pt-1">
					<Button label={t("extensions.browseMarket")} onClick={browse} icon={<Store size={13} strokeWidth={1.8} />} />
					{/* 同插件页那颗：开单子的入口留字，箭头跟着开合转身。 */}
					<Button variant="primary" menu={add.open} onClick={add.toggle}>
						{t("mcp.add")}
						<Caret open={add.open} size={13} />
					</Button>
				</div>
			</header>

			{add.open && (
				<Popover anchor={add.anchor} onClose={add.close} placement="bottom" align="end" width="default">
					<MenuBody>
						<MenuItem
							icon={<Store size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								browse();
							}}
						>
							{t("market.addRegistry")}
						</MenuItem>
						{/* Adds one and lands on it, rather than only switching tab — the label says 添加,
						    and a menu item that navigates instead of doing the thing it names is a lie. */}
						<MenuItem
							icon={<Cable size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								addServer("stdio");
							}}
						>
							{t("market.addMcpServer")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}

			{(outdated.length > 0 || (updates?.updating.length ?? 0) > 0) && (
				<div className={`mx-auto w-full max-w-[900px] shrink-0 pb-4 ${gutter}`}>
					<div className="flex items-center gap-3 rounded-xl bg-accent/8 px-4 py-2.5" data-settings-updates="">
						<ArrowUp size={14} strokeWidth={2.2} className="shrink-0 text-accent" />
						<p className="min-w-0 flex-1 truncate text-label text-ink">
							{updates?.updating.length ? t("market.updatingN", { n: updates.updating.length }) : t("market.updatesN", { n: outdated.length })}
							<span className="pl-2 text-detail text-ink-muted">{formatList(outdated.map((entry) => entry.name).slice(0, 3))}</span>
						</p>
						<Button variant="subtle" size="sm" loading={updatingAll || (updates?.updating.length ?? 0) > 0} onClick={() => void updateAll()} className="bg-accent/12 text-accent hover:bg-accent/20 hover:text-accent">
							{t("market.updateAll")}
						</Button>
					</div>
				</div>
			)}

			{/* One row: what to look at, and what to look for. */}
			<div className={`mx-auto flex w-full max-w-[900px] shrink-0 flex-wrap items-center gap-3 pb-5 ${gutter}`}>
				{/* 项目级的那一份看哪个项目，在这里明说——不再暗中跟着最后打开的会话走。 */}
				<ProjectScope value={workspace} projects={settings?.projects ?? []} onChange={setProject} />
				<div aria-hidden className="h-5 w-px shrink-0 bg-line" />
				<TabStrip
					label={t("common.plugins")}
					value={tab}
					onChange={setTab}
					items={tabs.map((entry) => ({
						id: entry.id,
						label: entry.label,
						count: entry.count,
						icon: <entry.icon size={13} strokeWidth={1.8} className="shrink-0" aria-hidden />,
					}))}
				/>

				<div className="min-w-2 flex-1" />
				<SearchField
					size="comfortable"
					value={query}
					onChange={setQuery}
					placeholder={t("common.search")}
					// 从 120 起算、有空再长到 220：固定 220 时，左边多了项目胶囊，这一行在常见窗口宽度下就折成两行。
					className="max-w-[220px] flex-1 basis-[120px]"
				/>

				{/*
				 * What this tab can do besides list things — only on the tabs that have something: the
				 * directory items used to be offered on 扩展 too, where they opened the plugins
				 * directory, which it is not.
				 */}
				{hasMenu && (
					<IconButton
						label={t("common.more")}
						menu={more.open}
						onClick={more.toggle}
						className="aria-expanded:bg-card-hover aria-expanded:text-ink"
						icon={<MoreHorizontal size={15} strokeWidth={1.9} />}
					/>
				)}
			</div>

			{more.open && (
				<Popover anchor={more.anchor} onClose={more.close} placement="bottom" align="end" width="default">
					<MenuBody>
						{tab === "mcp" ? (
							<>
								<MenuItem
									icon={<Plus size={13} strokeWidth={1.9} />}
									onClick={() => {
										more.close();
										addServer("stdio");
									}}
								>
									{t("extensions.addStdio")}
								</MenuItem>
								<MenuItem
									icon={<Plus size={13} strokeWidth={1.9} />}
									onClick={() => {
										more.close();
										addServer("http");
									}}
								>
									{t("extensions.addHttp")}
								</MenuItem>
							</>
						) : (
							<>
								<MenuItem
									icon={<FolderOpen size={13} strokeWidth={1.8} />}
									onClick={() => {
										more.close();
										void revealDir("user");
									}}
								>
									{t("extensions.userDir")}
								</MenuItem>
								<MenuItem
									icon={<FolderOpen size={13} strokeWidth={1.8} />}
									disabled={!workspace}
									title={workspace ? undefined : t("extensions.noProject")}
									onClick={() => {
										more.close();
										void revealDir("workspace");
									}}
								>
									{t("extensions.projectDir")}
								</MenuItem>
							</>
						)}
						{/* 自动更新管的是从市场装的一切，所以三栏都有它。 */}
						<MenuItem
							icon={<ArrowUp size={13} strokeWidth={1.9} />}
							checked={autoUpdate}
							onClick={() => {
								if (settings) void saveSettings({ ...settings, autoUpdatePlugins: !autoUpdate });
							}}
						>
							{t("market.autoUpdate")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}

			<RetainedViews key={workspace?.path ?? ""} active={tab} limit={4} pageClassName="" slide={TAB_ORDER} render={(shown) => (
				<Scroller className="flex-1" contentClassName="pb-10">
					{/*
					 * Column is inside the viewport, not the viewport itself.
					 *
					 * The overlay thumb sits on the host's right edge. If the host is the 900px
					 * column, that edge is the right of every full-width field, which then looked
					 * like it had a scrollbar growing out of it. The host fills the
					 * pane; the page still reads as the same column the header uses.
					 */}
					<div className={`mx-auto w-full max-w-[900px] ${gutter}`} data-ly-extensions-column="">
						{shown === "plugins" && <PluginsSettings filter={query} markOf={markOf} />}
						{shown === "skills" && <SkillsSettings filter={query} />}
						{shown === "mcp" && <McpSettings filter={query} markOf={markOf} />}
						{shown === "extensions" && <ExtensionHostSettings filter={query} />}
					</div>
				</Scroller>
			)} />

		</div>
	);
}
