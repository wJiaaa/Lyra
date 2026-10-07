/**
 * 命令面板里能找到的东西：会话，和应用里本来就有入口的那些动作。
 *
 * 这里只收集，不发明——每一条都是别处已经有的按钮或快捷键，调的是同一个函数：面板沿用工具栏
 * 「面板」菜单的清单和可用性（`usePanelDefinitions`），前往沿用侧栏和图标栏的 `setView`，项目沿用
 * 项目标题上那颗「在这个项目里新建会话」。所以别处改了行为，这里跟着变，不会长出第二套。
 */

import type { SessionMeta } from "@plume/core";
import { createElement, useMemo, type ReactNode } from "react";
import { useLayout } from "../../app/layout.tsx";
import { useI18n } from "../../i18n/index.ts";
import type { PaletteEntry } from "../../lib/palette.ts";
import { isScratch, listableSessions } from "../../lib/sidebar-grouping.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { useListedProjects } from "../../store/listed-projects.ts";
import { startProjectSession } from "../../store/project-session.ts";
import {
	Archive,
	AtSign,
	Clock,
	FolderOpen,
	FolderPlus,
	GitPullRequest,
	PanelLeft,
	Pin,
	PinOff,
	Settings,
	SquarePen,
} from "../../ui/icons/index.ts";
import { openScopedPanel, usePanelDefinitions } from "../dock/index.ts";
import { settingsGroups } from "../settings/index.ts";

export interface PaletteCommand extends PaletteEntry {
	id: string;
	icon?: ReactNode;
	/** 名字后面那段淡色的字：会话所在的项目、设置项所在的分组。 */
	meta?: string;
	/** 原样的快捷键（「⌘P」），画的时候按平台换写法。 */
	shortcut?: string;
	/** 这一项就是现在的状态，比如当前的主题。 */
	checked?: boolean;
	run(): void;
}

export interface PaletteGroup {
	key: string;
	label: string;
	commands: PaletteCommand[];
	/** 只在打了字以后出现：项目和设置项一列出来就是几十行，空着的时候会把常用的挤到看不见。 */
	onQuery?: boolean;
}

/** 空输入时列几条最近的会话。再多，下面的命令就被挤出第一屏了。 */
const RECENT = 6;

const icon = (component: typeof Settings) => createElement(component, { size: 15, strokeWidth: 1.8 });

export function usePaletteCommands({
	onOpenSession,
	onNewProject,
}: {
	onOpenSession: (meta: SessionMeta) => void;
	onNewProject: () => void;
}): { recent: PaletteGroup; sessions: PaletteGroup; groups: PaletteGroup[] } {
	const { t } = useI18n();
	const { toggleNav, dismissNav } = useLayout();
	const sessions = useApp((s) => s.sessions);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const scratchRoots = useApp((s) => s.scratchRoots);
	const meta = useApp((s) => s.meta);
	const settings = useApp((s) => s.settings);
	const setView = useApp((s) => s.setView);
	const setSettingsSection = useApp((s) => s.setSettingsSection);
	const saveSettings = useApp((s) => s.saveSettings);
	const newSession = useApp((s) => s.newSession);
	const setSessionPinned = useApp((s) => s.setSessionPinned);
	const setSessionArchived = useApp((s) => s.setSessionArchived);
	const notify = useApp((s) => s.notify);
	const panels = usePanelDefinitions();
	const projects = useListedProjects();

	/*
	 * 按最后活动排，不跟侧栏的排序设置走：搜索要回答的是「刚才那段在哪」，侧栏按创建时间或手动排的
	 * 时候，最近动过的那条可能在很下面。同分的会话保持这个顺序，所以打字以后也是新的在前。
	 */
	const sessionCommands = useMemo(
		() =>
			listableSessions(sessions, activeSessionId)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((session): PaletteCommand => {
					const project = isScratch(session.cwd, scratchRoots) ? undefined : session.projectName;
					return {
						id: `session:${session.id}`,
						label: session.title,
						keywords: project ? [project] : [],
						meta: project,
						run: () => onOpenSession(session),
					};
				}),
		[sessions, activeSessionId, scratchRoots, onOpenSession],
	);

	const groups = useMemo((): PaletteGroup[] => {
		const go = (view: Parameters<typeof setView>[0]) => () => {
			setView(view);
			dismissNav();
		};
		const pinned = meta ? (settings?.pinnedSessionIds ?? []).includes(meta.id) : false;
		const theme = settings?.appearance.theme;
		const setTheme = (next: "light" | "dark" | "system") => () => {
			if (settings) void saveSettings({ ...settings, appearance: { ...settings.appearance, theme: next } });
		};

		return [
			{
				key: "chat",
				label: t("palette.chat"),
				commands: [
					{
						id: "new-chat",
						label: t("sidebar.newChat"),
						icon: icon(SquarePen),
						run: () => {
							void newSession();
							dismissNav();
						},
					},
					...(meta && !meta.archived
						? [
								{
									id: "pin-current",
									label: t(pinned ? "palette.unpinCurrent" : "palette.pinCurrent"),
									icon: icon(pinned ? PinOff : Pin),
									run: () => {
										void setSessionPinned(meta.id, !pinned);
										notify(t(pinned ? "sessionMenu.unpinned" : "sessionMenu.pinned"));
									},
								},
								{
									id: "archive-current",
									label: t("palette.archiveCurrent"),
									icon: icon(Archive),
									run: () => void setSessionArchived(meta, true),
								},
							]
						: []),
				],
			},
			{
				key: "go",
				label: t("palette.goTo"),
				commands: [
					{ id: "go-pull-requests", label: t("sidebar.pullRequests"), icon: icon(GitPullRequest), run: go("pull-requests") },
					{ id: "go-scheduled", label: t("sidebar.scheduled"), icon: icon(Clock), run: go("scheduled") },
					{ id: "go-plugins", label: t("sidebar.plugins"), icon: icon(AtSign), run: go("plugins") },
					{ id: "go-settings", label: t("sidebar.settings"), icon: icon(Settings), run: go("settings") },
					{ id: "toggle-sidebar", label: t("palette.toggleSidebar"), icon: icon(PanelLeft), shortcut: "⌘B", run: toggleNav },
				],
			},
			{
				key: "panels",
				label: t("toolbar.panels"),
				commands: panels
					.filter((panel) => !panel.unavailable && panel.listed !== false)
					.map((panel) => ({
						id: `panel:${panel.kind}`,
						label: t(panel.label),
						keywords: [panel.kind, t("toolbar.panels")],
						icon: createElement(panel.icon, { size: 15, strokeWidth: 1.8 }),
						shortcut: panel.shortcut || undefined,
						// 打开或拿到前面，不做开关：从面板里选「终端」的人要的是终端，不是把开着的那个关掉。
						run: () => void openScopedPanel(panel.kind),
					})),
			},
			{
				key: "theme",
				label: t("appearance.theme"),
				commands: [
					{ id: "theme-light", label: t("appearance.light"), keywords: [t("appearance.theme"), "light"], checked: theme === "light", run: setTheme("light") },
					{ id: "theme-dark", label: t("appearance.dark"), keywords: [t("appearance.theme"), "dark"], checked: theme === "dark", run: setTheme("dark") },
					{ id: "theme-system", label: t("common.system"), keywords: [t("appearance.theme"), "system"], checked: theme === "system", run: setTheme("system") },
				],
			},
			{
				key: "projects",
				label: t("common.project"),
				onQuery: true,
				commands: [
					...projects.map((project) => ({
						id: `project:${project.path}`,
						label: project.name,
						meta: t("projectHead.newSession"),
						icon: icon(FolderOpen),
						run: () => {
							void startProjectSession(project.path);
							dismissNav();
						},
					})),
					{ id: "new-project", label: t("project.new"), icon: icon(FolderPlus), run: onNewProject },
				],
			},
			{
				key: "settings",
				label: t("sidebar.settings"),
				onQuery: true,
				commands: settingsGroups(bridge.platform ?? "darwin").flatMap((group) =>
					group.items.map((item) => ({
						id: `settings:${item.id}`,
						label: t(item.labelKey),
						keywords: [t("sidebar.settings"), t(group.labelKey)],
						meta: t("sidebar.settings"),
						icon: createElement(item.icon, { size: 15, strokeWidth: 1.8 }),
						run: () => {
							setSettingsSection(item.id);
							setView("settings");
							dismissNav();
						},
					})),
				),
			},
		];
	}, [t, toggleNav, dismissNav, meta, settings, panels, projects, onNewProject, setView, setSettingsSection, saveSettings, newSession, setSessionPinned, setSessionArchived, notify]);

	return {
		recent: { key: "recent", label: t("palette.recent"), commands: sessionCommands.slice(0, RECENT) },
		sessions: { key: "sessions", label: t("palette.sessions"), commands: sessionCommands },
		groups,
	};
}
