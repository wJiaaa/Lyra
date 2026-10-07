import type { ProjectEntry } from "@plume/core";
import { Check, ChevronDown, Folder, Monitor } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { MENU_MAX_HEIGHT, MenuBody, MenuItem, MenuLabel, MenuSeparator, Popover, usePopover } from "../../ui/overlay/Popover.tsx";

/**
 * 这一页看哪个项目：用户级，或某一个项目的项目级内容。插件、命令、钩子三页共用。
 *
 * 胶囊跟右边的标签条同高同圆角，靠一圈细线立住而不是垫底色——它是「在哪儿看」，不是标签里的
 * 又一项，所以不进那条轨道，中间用一道竖线隔开。
 */
export function ProjectScope({
	value,
	projects,
	onChange,
}: {
	value: ProjectEntry | null;
	projects: readonly ProjectEntry[];
	onChange: (path: string | null) => void;
}) {
	const { t } = useI18n();
	const menu = usePopover();
	const iconOf = (project: ProjectEntry | null) =>
		project ? <Folder size={14} strokeWidth={1.8} className="shrink-0" /> : <Monitor size={14} strokeWidth={1.8} className="shrink-0" />;
	const option = (project: ProjectEntry | null) => {
		const chosen = (project?.path ?? null) === (value?.path ?? null);
		return (
			<MenuItem
				key={project?.path ?? ""}
				selected={chosen}
				icon={iconOf(project)}
				trailing={chosen ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" /> : undefined}
				onClick={() => {
					onChange(project?.path ?? null);
					menu.close();
				}}
			>
				{project?.name ?? t("common.user")}
			</MenuItem>
		);
	};
	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-label={t("extensions.projectScope")}
				data-ly-project-scope=""
				aria-haspopup="menu"
				aria-expanded={menu.open}
				className="flex h-[34px] max-w-[180px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-label text-ink shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover aria-expanded:bg-card-hover"
			>
				{iconOf(value)}
				<span className="min-w-0 truncate">{value?.name ?? t("common.user")}</span>
				<ChevronDown
					size={13}
					strokeWidth={1.9}
					className="shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-quick)]"
					style={menu.open ? { transform: "rotate(180deg)" } : undefined}
				/>
			</button>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						{option(null)}
						{projects.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel>{t("common.workspace")}</MenuLabel>
								{projects.map(option)}
							</>
						)}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}
