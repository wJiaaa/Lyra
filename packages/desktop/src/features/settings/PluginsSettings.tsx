/**
 * What is installed, and whether it is on.
 *
 * That is the whole page: a row per plugin — its mark, its name and version, one line about it — a
 * switch, and a ⋯ for the rest. 更新 appears on the row when the registry has a newer version and
 * automatic updating has not got to it yet. Everything else about a plugin (its skills, its licence,
 * its repository, things to try) is its page in the market, which 查看详情 opens.
 */

import { useI18n } from "../../i18n/index.ts";
import type { Plugin } from "@plume/core";
import { ArrowUp, FolderOpen, MoreHorizontal, Store, TriangleAlert, Trash2 } from "../../ui/icons/index.ts";
import { useState } from "react";

import { Confirm } from "../../ui/overlay/Confirm.tsx";
import { MenuBody, MenuItem, MenuSeparator, Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { useApp } from "../../store/index.ts";
import { usePluginsProject } from "./usePluginsProject.ts";
import { SkeletonList, useSlowLoad } from "../../ui/primitives/Skeleton.tsx";
import { settingsAfterToggle, useLocalScan, type MarketMark } from "../plugins/index.ts";
import { Card, ListRow, Toggle } from "./controls.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import { ProjectOverrideNotice } from "./ProjectOverrideNotice.tsx";
import { bridge } from "../../services/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

export function PluginsSettings({ filter = "", markOf }: { filter?: string; markOf?: (id?: string, name?: string) => MarketMark | undefined }) {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const setView = useApp((s) => s.setView);
	const setPluginFocus = useApp((s) => s.setPluginFocus);
	const bumpExtensions = useApp((s) => s.bumpExtensions);
	const updates = useApp((s) => s.pluginUpdates);
	const cwd = usePluginsProject()?.path;
	const { scan } = useLocalScan(cwd ?? "");
	/*
	 * A local scan is usually instantaneous, so the placeholder is for the case where it is not — a
	 * workspace with a lot of skill directories, or a cold filesystem cache.
	 */
	const slow = useSlowLoad(scan === null);

	if (!settings) return null;
	const needle = filter.trim().toLowerCase();
	const plugins = (scan?.plugins ?? []).filter(
		(p) => !needle || `${p.id} ${p.manifest.name ?? ""} ${p.manifest.interface?.shortDescription ?? ""}`.toLowerCase().includes(needle),
	);
	/*
	 * Two lists, because they answer different questions. A problem is a plugin that did not load;
	 * a warning is one that did, with a skill that may not behave as written — a short description,
	 * an `allowed-tools` entry Plume cannot honour. Counted together, a short description read as a
	 * broken plugin.
	 *
	 * Warnings are counted by skill, because one file can carry several and the header says how many
	 * skills. Problems stay one per line: that header counts problems, and each is its own to fix.
	 */
	const diagnostics = (scan?.pluginDiagnostics ?? []).filter((diagnostic) => diagnostic.severity !== "warning");
	const warnings = (scan?.pluginDiagnostics ?? []).filter((diagnostic) => diagnostic.severity === "warning");
	const warned = new Set(warnings.map((warning) => warning.path)).size;
	const behind = new Set((updates?.outdated ?? []).map((entry) => entry.id));

	/* `*` means "none of them" and is still shown to the user below; the rule for clearing it lives
	   in `settingsAfterToggle`, because the market switches plugins too. */
	const allOff = settings.disabledPlugins.includes("*");

	const toggle = (plugin: Plugin, enabled: boolean) => {
		void saveSettings(settingsAfterToggle(settings, plugin, enabled, scan?.plugins ?? []));
	};

	/** The bundle's own page, in the market — a different view, not a panel in here. */
	const details = (plugin: Plugin) => {
		setPluginFocus(plugin.id);
		setView("plugins");
	};

	return (
		<div>
			<ProjectOverrideNotice keys={["disabledPlugins"]} cwd={cwd} />
			{/* The notices are the commands page's, so a failure reads the same on every definition page. */}
			{diagnostics.length > 0 && (
				<div className="mb-5 flex items-start gap-2 rounded-[10px] border border-accent/35 bg-accent/6 px-3.5 py-2.5 text-detail text-ink-muted">
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
					<div className="min-w-0">
						<div className="text-accent">{t("pluginsSettings.problems", { n: diagnostics.length })}</div>
						{/* By position: a path repeats when one file has two diagnostics, and these rows hold no state. */}
						{diagnostics.map((diagnostic, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</div>
			)}

			{warnings.length > 0 && (
				<div className="mb-5 flex items-start gap-2 rounded-[10px] border border-line px-3.5 py-2.5 text-detail text-ink-faint">
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
					<div className="min-w-0">
						<div className="text-ink-muted">{t("pluginsSettings.warnings", { n: warned })}</div>
						{warnings.map((warning, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{warning.path}</span> — {warning.message}
							</div>
						))}
					</div>
				</div>
			)}

			{/*
			 * Said out loud, because otherwise the page is a list of plugins that are all off for no
			 * visible reason — indistinguishable from having switched each one off.
			 */}
			{allOff && plugins.length > 0 && (
				<p className="mb-5 rounded-[10px] border border-line px-3.5 py-2.5 text-detail leading-relaxed text-ink-muted">
					{t("plugins.settingsSays")} <code className="font-mono">disabledPlugins: ["*"]</code>
					{t("plugins.allOffDetail")}
				</p>
			)}

			{slow ? (
				<SkeletonList count={5} label={t("plugins.reading")} />
			) : scan === null ? null : plugins.length === 0 ? (
				<Card>
					{needle ? (
						<p className="px-6 py-10 text-center text-label text-ink-faint">{t("plugins.noMatch")}</p>
					) : (
						<div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
							<div className="text-label font-medium text-ink">{t("plugins.empty")}</div>
							<p className="max-w-[360px] text-detail text-ink-faint">{t("pluginsSettings.emptyDetail")}</p>
							<Button
								variant="primary"
								onClick={() => {
									setPluginFocus(null);
									setView("plugins");
								}}
								icon={<Store size={13} strokeWidth={1.8} aria-hidden />}
								className="mt-2"
							>
								{t("pluginsSettings.browse")}
							</Button>
						</div>
					)}
				</Card>
			) : (
				/* The settings card the hooks and commands lists sit in, rows ruled the same way. */
				<Card className="divide-y divide-line-soft">
					{plugins.map((plugin) => (
						<PluginRow
							key={plugin.id}
							plugin={plugin}
							outdated={behind.has(plugin.id)}
							updating={updates?.updating.includes(plugin.id) ?? false}
							mark={markOf?.(plugin.id, plugin.manifest.interface?.displayName ?? plugin.manifest.name)}
							onToggle={(enabled) => toggle(plugin, enabled)}
							onDetails={() => details(plugin)}
							onChanged={bumpExtensions}
						/>
					))}
				</Card>
			)}
		</div>
	);
}

function PluginRow({
	plugin,
	mark,
	outdated,
	updating,
	onToggle,
	onDetails,
	onChanged,
}: {
	plugin: Plugin;
	/** The market's picture for it, when the bundle's own manifest names none. */
	mark?: MarketMark;
	outdated: boolean;
	updating: boolean;
	onToggle: (enabled: boolean) => void;
	onDetails: () => void;
	onChanged: () => void;
}) {
	const { t } = useI18n();
	const [busy, setBusy] = useState<"update" | "uninstall" | null>(null);
	const menu = usePopover();
	const [confirming, setConfirming] = useState(false);
	const ui = plugin.manifest.interface;
	// The market's name and line when it came from there: curated, and the same words the market card uses.
	const name = mark?.name ?? ui?.displayName ?? plugin.manifest.name ?? plugin.id;
	/** A bundle inside the project's own directory is removed by deleting it there. */
	const removable = plugin.source !== "workspace";

	const uninstall = async () => {
		setBusy("uninstall");
		await bridge.plugins.uninstall(plugin.id);
		setBusy(null);
		onChanged();
	};
	const update = async () => {
		setBusy("update");
		await bridge.plugins.updateAll([plugin.id]).catch(() => undefined);
		setBusy(null);
		onChanged();
	};

	return (
		<>
			{/* Mark, name and line sized like a hook or command row: 36px, label over detail. */}
			<ListRow
				flush
				icon={<PluginIcon name={name} logo={ui?.logo ?? mark?.logo} brandColor={ui?.brandColor ?? mark?.brandColor} kind="plugin" size={36} />}
				title={
					<span className="flex min-w-0 items-center gap-2 text-label font-medium">
						<span className="truncate">{name}</span>
						{plugin.manifest.version && <span className="shrink-0 text-detail font-normal text-ink-faint tabular-nums">v{plugin.manifest.version}</span>}
						{plugin.source === "workspace" && <span className="shrink-0 text-detail font-normal text-ink-faint">{t("common.project")}</span>}
					</span>
				}
				/* A block with its own 2px, so name and line sit 4px apart as on a hook row. */
				detail={<span className="mt-0.5 block truncate text-detail text-ink-faint">{mark?.description ?? ui?.shortDescription ?? plugin.manifest.description ?? t("market.noTagline")}</span>}
				onOpen={onDetails}
				openLabel={t("plugins.openNamed", { name })}
				actions={
					<>
						{(outdated || updating) && (
							<Button
								variant="subtle"
								size="sm"
								disabled={busy !== null || updating}
								onClick={() => void update()}
								icon={busy === "update" || updating ? <ActionSpinner size={11} /> : <ArrowUp size={11} strokeWidth={2.2} aria-hidden />}
								className="bg-accent/12 text-accent hover:bg-accent/20 hover:text-accent"
							>
								{busy === "update" || updating ? t("market.updating") : t("common.update")}
							</Button>
						)}
					</>
				}
				/*
				 * Switch, then ⋯ at the far end — the order the MCP cards use, so the switches of both
				 * tabs sit in the same place and the menu is always the last thing.
				 */
				control={
					<div className="flex items-center gap-2">
						<Toggle checked={plugin.enabled} onChange={onToggle} ariaLabel={t("market.enableNamed", { name })} />
						<IconButton
							label={t("common.more")}
							ariaLabel={t("plugins.moreFor", { name })}
							menu={menu.open}
							onClick={menu.toggle}
							className="opacity-0 transition-[color,background-color,opacity] group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
							icon={busy === "uninstall" ? <ActionSpinner size={13} /> : <MoreHorizontal size={15} strokeWidth={1.9} />}
						/>
					</div>
				}
			/>

			{/* The question is a modal, so the menu is only ever a menu — see `Confirm`. */}
			{confirming && (
				<Confirm
					title={t("plugins.uninstallConfirm", { name })}
					detail={t("plugins.uninstallDetail")}
					confirmLabel={t("mcp.uninstall")}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						void uninstall();
					}}
				/>
			)}

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="compact" role="menu" label={name}>
					<MenuBody>
						<MenuItem
							icon={<Store size={13} strokeWidth={1.8} />}
							onClick={() => {
								menu.close();
								onDetails();
							}}
						>
							{t("pluginsSettings.details")}
						</MenuItem>
						<MenuItem
							icon={<FolderOpen size={13} strokeWidth={1.8} />}
							onClick={() => {
								menu.close();
								void bridge.system.openPath(plugin.dir);
							}}
						>
							{t("common.openFolder")}
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							danger
							icon={<Trash2 size={13} strokeWidth={1.8} />}
							disabled={busy !== null || !removable}
							title={removable ? undefined : t("plugins.projectScoped")}
							onClick={() => {
								menu.close();
								setConfirming(true);
							}}
						>
							{t("mcp.uninstall")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
		</>
	);
}
