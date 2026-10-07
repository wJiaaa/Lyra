/**
 * 钩子：用户级的存在设置文件里，项目级的存在当前项目的 `.plume/config.json` 里。
 *
 * 布局：顶上一行是范围、数量和搜索，下面「已安装」一段，每条一行，点开是表单。项目钩子
 * 来自项目目录——可能是别人提交进来的——所以没信任过的那几条开关是灰的，旁边给一个「信任」。
 */

import type { HookDraft, HookScope } from "@plume/core";
import { Anchor, Plus, RefreshCw, ShieldCheck, TriangleAlert } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HookView, HooksView } from "../../../electron/ipc-types.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { Toggle } from "./controls.tsx";
import { HookForm } from "./HookForm.tsx";
import { ProjectScope } from "./ProjectScope.tsx";
import { Card } from "./layout.tsx";

function matchesQuery(hook: HookView, query: string): boolean {
	if (!query) return true;
	return [hook.event, hook.type, hook.matcher, hook.command, ...(hook.args ?? [])].some((value) => value?.toLowerCase().includes(query));
}

export function HooksSettings() {
	const { t } = useI18n();
	const projects = useApp((s) => s.settings?.projects) ?? [];
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const projectPath = useApp((s) => s.hooksProject);
	const setProjectPath = useApp((s) => s.setHooksProject);
	const project = projects.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? null;
	const scope: HookScope = project ? "project" : "user";
	const [view, setView] = useState<HooksView | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	/** `undefined` 是列表；`null` 是新建；一条钩子是在编辑它。 */
	const [editing, setEditing] = useState<HookView | null | undefined>(undefined);
	const confirm = useConfirmer();

	const refresh = useCallback(() => {
		void bridge.hooks
			.list(cwd)
			.then((next) => {
				setView(next);
				setError(null);
			})
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [cwd]);

	useEffect(refresh, [refresh]);
	// 项目钩子写在项目目录的文件里，拉一次代码就可能变了。回到窗口时重读，不留一份过期的列表。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	async function run(id: string, action: () => Promise<HooksView>) {
		setBusy(id);
		try {
			setView(await action());
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(null);
		}
	}

	const scopes = useMemo(
		() => [{ value: "user" as const, label: t("common.user") }, ...(project ? [{ value: "project" as const, label: project.name }] : [])],
		[project, t],
	);

	if (editing !== undefined) {
		const target = editing;
		return (
			<>
				<HookForm
					key={target?.id ?? "new"}
					hook={target ?? undefined}
					scopes={scopes}
					defaultScope={scope}
					onCancel={() => setEditing(undefined)}
					onSave={async (saveScope: HookScope, draft: HookDraft) => {
						try {
							setView(await bridge.hooks.save(saveScope, cwd, target?.id ?? null, draft));
							setError(null);
							if (saveScope === "user") setProjectPath(null);
							setEditing(undefined);
						} catch (reason) {
							setError(reason instanceof Error ? reason.message : String(reason));
						}
					}}
					onDelete={
						target
							? () =>
									confirm.ask({
										title: t("hooks.delete"),
										detail: t("hooks.deleteDetail", { event: target.event }),
										confirmLabel: t("common.delete"),
										onConfirm: () => {
											void run(target.id, () => bridge.hooks.remove(target.scope, cwd, target.id)).then(() => setEditing(undefined));
										},
									})
							: undefined
					}
				/>
				{error && <p className="mt-3 text-detail text-danger">{error}</p>}
				{confirm.element}
			</>
		);
	}

	const hooks = (scope === "project" ? view?.project : view?.user) ?? [];
	const needle = query.trim().toLowerCase();
	const visible = hooks.filter((hook) => matchesQuery(hook, needle));
	const untrusted = scope === "project" && hooks.some((hook) => hook.trusted === false);

	return (
		<div className="pt-2" data-ly-hooks-settings="">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("hooks.title")}</h1>
			<p className="mt-2 text-label text-ink-muted">{t("hooks.intro")}</p>

			<div className="mt-6 flex min-w-0 flex-wrap items-center gap-3">
				<ProjectScope value={project} projects={projects} onChange={setProjectPath} />
				<div className="h-4 w-px bg-line" aria-hidden />
				<div className="flex items-center gap-1 text-label font-medium text-ink">
					{t("hooks.title")}
					<span className="text-detail font-normal text-ink-faint">{visible.length}</span>
				</div>
				<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={t("hooks.searchPlaceholder")} className="ml-auto max-w-[220px] flex-1 basis-[120px]" />
			</div>

			{untrusted && view?.projectPath && (
				<div className="mt-5 flex items-start gap-2 rounded-[10px] border border-accent/35 bg-accent/6 px-3.5 py-2.5 text-detail text-ink-muted">
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
					<span>{t("hooks.trustNotice", { path: view.projectPath })}</span>
				</div>
			)}
			{scope === "project" && view?.projectError && (
				<p className="mt-5 rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-detail text-danger">
					{t("hooks.projectError", { error: view.projectError })}
				</p>
			)}
			{error && <p className="mt-5 rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-detail text-danger">{error}</p>}

			<section className="mt-6">
				<div className="mb-4 flex items-center justify-between gap-3">
					<h2 className="flex h-7 items-center gap-1.5 text-label font-medium text-ink">
						{t("hooks.installed")}
						<span className="text-detail font-normal text-ink-faint">{hooks.length}</span>
					</h2>
					<div className="flex items-center gap-1.5">
						<Button variant="subtle" size="sm" icon={<RefreshCw size={13} aria-hidden />} label={t("common.refresh")} onClick={refresh} />
						<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => setEditing(null)}>
							{t("common.new")}
						</Button>
					</div>
				</div>

				{hooks.length === 0 ? (
					<Card>
						<div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
							<div className="text-label font-medium text-ink">{t("hooks.emptyTitle")}</div>
							<p className="max-w-[360px] text-detail text-ink-faint">{t("hooks.emptyDetail")}</p>
							<Button variant="primary" className="mt-2" icon={<Plus size={13} aria-hidden />} onClick={() => setEditing(null)}>
								{t("hooks.add")}
							</Button>
						</div>
					</Card>
				) : visible.length === 0 ? (
					<Card>
						<p className="px-6 py-10 text-center text-label text-ink-faint">{t("hooks.searchEmpty")}</p>
					</Card>
				) : (
					<Card className="divide-y divide-line-soft">
						{visible.map((hook) => (
							<HookRow
								key={hook.id}
								hook={hook}
								busy={busy === hook.id}
								onEdit={() => setEditing(hook)}
								onTrust={() => cwd && void run(hook.id, () => bridge.hooks.trust(cwd, [hook.id]))}
								onToggle={(enabled) => void run(hook.id, () => bridge.hooks.setEnabled(hook.scope, cwd, hook.id, enabled))}
							/>
						))}
					</Card>
				)}
			</section>
		</div>
	);
}

function HookRow({
	hook,
	busy,
	onEdit,
	onTrust,
	onToggle,
}: {
	hook: HookView;
	busy: boolean;
	onEdit: () => void;
	onTrust: () => void;
	onToggle: (enabled: boolean) => void;
}) {
	const { t } = useI18n();
	const untrusted = hook.trusted === false;
	const command = [hook.command, ...(hook.args ?? [])].join(" ");

	return (
		<div
			role="button"
			tabIndex={0}
			data-ly-hook-row=""
			onClick={busy ? undefined : onEdit}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget || busy) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onEdit();
				}
			}}
			className="flex cursor-default items-center gap-3 px-4 py-3 transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover"
		>
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-shell text-ink-faint" aria-hidden>
				<Anchor size={16} strokeWidth={1.8} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-label font-medium text-ink">{hook.event}</span>
					{hook.matcher && <span className="truncate font-mono text-detail text-ink-faint">{hook.matcher}</span>}
				</div>
				<p className="mt-1 truncate font-mono text-detail text-ink-faint">{command}</p>
			</div>
			{/* 行上的控件不冒泡：点「信任」或开关不该顺便打开编辑表单。 */}
			<div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
				{untrusted && (
					<Button size="sm" disabled={busy} icon={<ShieldCheck size={13} aria-hidden />} onClick={onTrust}>
						{t("hooks.trust")}
					</Button>
				)}
				{/* 没信任的强制显示为关、并且不能开：先审，再用。 */}
				<Toggle checked={untrusted ? false : hook.enabled} onChange={onToggle} disabled={busy || untrusted} ariaLabel={hook.event} />
			</div>
		</div>
	);
}
