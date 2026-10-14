/**
 * 「在 Cursor 中打开」：左边整块点了直接打开，右边 ▾ 换一个打开方式。
 *
 * 换的那个写回设置里已有的「默认文件打开目标」（`editor.defaultOpenTarget`），不另存一份：文件预览
 * 那颗按钮读的也是它，两处说的是同一个「我用什么打开」。图标是主进程从系统里取来的应用图标，和
 * 设置页那一栏同一份。
 */

import { ChevronDown, FolderOpen } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { openLabel, revealLabel, useOpenTarget, useOpenTargets } from "../../store/open-targets.ts";
import { useScopedWorkspace } from "../../app/session-scope.tsx";
import { MenuBody, MenuItem, Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import type { OpenTarget } from "../../../electron/ipc-types.ts";
import { ROW, Section } from "./rows.tsx";

function TargetIcon({ target }: { target: OpenTarget }) {
	if (target.icon) return <img src={target.icon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />;
	return <FolderOpen size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
}

export function OpenInSection() {
	const { t } = useI18n();
	const { workspace, scratchCwd } = useScopedWorkspace();
	const dir = workspace?.path ?? scratchCwd;
	const targets = useOpenTargets();
	const current = useOpenTarget();
	const menu = usePopover();
	if (!dir) return null;

	const open = (target: OpenTarget) => void bridge.system.openIn(target.id, dir).catch((error: unknown) => useApp.getState().notify(String(error), "error"));
	const choose = (target: OpenTarget) => {
		menu.close();
		const settings = useApp.getState().settings;
		if (settings && settings.editor.defaultOpenTarget !== target.id) void useApp.getState().saveSettings({ ...settings, editor: { ...settings.editor, defaultOpenTarget: target.id } });
		open(target);
	};

	return (
		<Section name="openIn">
			<div className="flex items-center gap-0.5">
				<button type="button" data-ly-open-in={current.id} className={`${ROW} flex-1`} onClick={() => open(current)}>
					<TargetIcon target={current} />
					<span className="min-w-0 flex-1 truncate">{openLabel(current)}</span>
				</button>
				<button
					type="button"
					aria-label={t("environment.openWith")}
					data-ly-tip={t("environment.openWith")}
					aria-expanded={menu.open}
					onClick={menu.toggle}
					className="flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
				>
					<ChevronDown size={12.5} strokeWidth={1.9} />
				</button>
			</div>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default">
					<MenuBody>
						{targets.map((target) => (
							<MenuItem key={target.id} icon={<TargetIcon target={target} />} selected={target.id === current.id} onClick={() => choose(target)}>
								{target.id === "reveal" ? revealLabel() : target.label}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</Section>
	);
}
