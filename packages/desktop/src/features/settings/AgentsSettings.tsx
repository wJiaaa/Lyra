import { BUILTIN_AGENTS } from "@lyra/core/agents-builtin";
import type { Settings } from "@lyra/core";
import { agentProfile, withAgentProfile, availableModels, resolveModelRef, type SubAgentProfile } from "@lyra/core/model-roles";
import { resolveModelThinkingOptions, resolveThinkingOption } from "@lyra/core/thinking-options";
import { AlertCircle, Brain, Plus, Copy, RefreshCcw, RotateCcw, Search, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store/index.ts";
import { useAgentAvatars, type AvatarOf } from "../../store/agent-avatars.ts";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { InlineSelect } from "./controls.tsx";
import { ModelSelect } from "../models/index.ts";
import { AgentDefinitionEditor } from "./AgentDefinitionEditor.tsx";
import { useAgentDefinitions } from "./useAgentDefinitions.ts";
import { ProjectScope } from "./ProjectScope.tsx";
import type { AgentDefinitionRecord } from "@lyra/core";
import { bridge } from "../../services/index.ts";
import { Input } from "../../ui/inputs/NativeField.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { useI18n } from "../../i18n/index.ts";

type Agent = AgentCapabilities["agents"][number];

/*
 * 这一页：工具条（标题、数量、搜索）、「已安装」「内置」两组、组里是一块
 * 没有描边的浅面，行与行之间一道半透明的线，点一行进编辑。颜色取自 `[data-agent-settings]`
 * 上的几个变量，见 `styles/fields.css`。
 */

export function AgentsSettings() {
	const { t } = useI18n();
	const projects = useApp((s) => s.settings?.projects) ?? [];
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const project = projects.find((entry) => entry.path === projectPath) ?? null;
	const catalogue = useAgentDefinitions(project);
	const [editor, setEditor] = useState<{ record?: AgentDefinitionRecord; copy?: boolean; projectId: string | null } | null>(null);
	const [undo, setUndo] = useState<{ token: string; projectId: string | null } | null>(null);
	const [notice, setNotice] = useState("");
	// 刚存下的那一个：行底色亮一下，脸也跟着高兴一下（`at` 让同一个人连存两次也各算一次）。
	const [highlight, setHighlight] = useState<{ name: string; at: number } | null>(null);
	const [query, setQuery] = useState("");
	const confirm = useConfirmer();
	const activeSessionId = useApp((s) => s.activeSessionId);
	const settings = useApp((s) => s.settings);
	const mainModelId = useApp((s) => s.meta?.modelId);
	const sharedCapabilities = useApp((s) => s.capabilities);
	const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setCapabilities(activeSessionId ? sharedCapabilities : null);
		setError("");
		if (!activeSessionId || sharedCapabilities) return;
		void bridge.sessions.capabilities(activeSessionId).then((value) => {
			if (!cancelled) setCapabilities(value);
		}).catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { cancelled = true; };
	}, [activeSessionId, sharedCapabilities]);

	async function persist(next: Settings) {
		if (savingRef.current) return;
		savingRef.current = true; setSaving(true); setError("");
		try { await useApp.getState().saveSettings(next); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { savingRef.current = false; setSaving(false); }
	}

	function save(name: string, profile: SubAgentProfile) {
		const current = useApp.getState().settings;
		if (current) void persist(withAgentProfile(current, name, profile));
	}

	const agents: Agent[] = useMemo(
		() => catalogue.records?.map(record => record.definition) ?? capabilities?.agents ?? BUILTIN_AGENTS,
		[catalogue.records, capabilities?.agents],
	);
	const avatarOf = useAgentAvatars(agents);
	const recordOf = (name: string) => catalogue.records?.find(record => record.definition.name === name);
	const openEditor = async (record: AgentDefinitionRecord, copy = false) => {
		try { const fresh = await bridge.agentDefinitions.read(catalogue.projectId, record.id); setEditor({ record: fresh, copy, projectId: catalogue.projectId }); }
		catch (cause) { setError(String(cause)); }
	};
	const remove = async (record: AgentDefinitionRecord) => {
		setSaving(true);
		try {
			const result = await bridge.agentDefinitions.remove(catalogue.projectId, record.id, record.revision);
			setUndo({ token: result.undoToken, projectId: catalogue.projectId }); setNotice(result.warning ?? t("agents.removed")); await catalogue.refresh();
		} catch (cause) { setError(String(cause)); }
		finally { setSaving(false); }
	};
	/* 删除先问一句；删掉之后列表上方仍然给一次撤销。 */
	const askRemove = (record: AgentDefinitionRecord, then?: () => void) => confirm.ask({
		title: t("agents.delete"),
		detail: t("agents.deleteConfirm", { name: record.definition.name }),
		confirmLabel: t("common.delete"),
		onConfirm: () => { then?.(); void remove(record); },
	});

	if (editor) {
		const record = editor.record;
		const deletable = record && !editor.copy && record.editable && record.scope !== "builtin" && !record.customized;
		return <>
			<AgentDefinitionEditor record={record} copy={editor.copy} projectId={editor.projectId} projectName={catalogue.projectName} defaultScope={project ? "project" : "user"} tools={catalogue.tools}
				avatarOf={avatarOf} taken={agents.filter(agent => !record || editor.copy || agent.name !== record.definition.name).map(agent => ({ name: agent.name, avatar: avatarOf(agent.name) }))}
				onClose={() => setEditor(null)} onDelete={deletable ? () => askRemove(record, () => setEditor(null)) : undefined}
				onSaved={(name, warning) => { setEditor(null); setHighlight({ name, at: Date.now() }); setNotice(warning ?? t("agents.savedForNext")); void catalogue.refresh(); }} />
			{confirm.element}
		</>;
	}

	const needle = query.trim().toLowerCase();
	const matches = (agent: Agent) => !needle || [agent.name, agent.description, agent.source, ...(agent.tools === "*" ? [] : agent.tools)].some(value => value.toLowerCase().includes(needle));
	/*
	 * 跟命令、钩子一样，「已安装」只列选中那一层自己的。改过的内置存在用户级（编辑内置总是存到
	 * 那里），看项目时它不属于这一层，归回「内置」一组，不然就从页面上消失了。
	 */
	const own = project ? "workspace" : "user";
	const installed = agents.filter(agent => agent.source === own && matches(agent));
	const builtin = agents.filter(agent => (agent.source === "builtin" || (project && agent.source === "user" && recordOf(agent.name)?.customized)) && matches(agent));
	const count = installed.length + builtin.length;
	const create = () => setEditor({ projectId: catalogue.projectId });
	const row = (agent: Agent) => {
		const record = recordOf(agent.name);
		return <AgentRow key={agent.name} agent={agent} record={record} avatarOf={avatarOf} saved={highlight?.name === agent.name ? highlight.at : null} disabled={saving}
			controls={settings && <AgentModelControls agent={agent} settings={settings} mainModelId={mainModelId} disabled={saving} onChange={(profile) => { void save(agent.name, profile); }} />}
			edit={record?.editable ? () => void openEditor(record) : undefined}
			copy={record ? () => void openEditor(record, true) : undefined}
			remove={record?.editable && record.scope !== "builtin" ? () => record.customized ? void remove(record) : askRemove(record) : undefined} />;
	};

	return (
		<div data-agent-settings className="pt-2 pb-10">
			<h1 className="pb-8 text-display leading-tight font-semibold tracking-tight text-ink">{t("agents.title")}</h1>
			<div className="@container space-y-6">
				<div className="flex min-w-0 flex-wrap items-center gap-3">
					<ProjectScope value={project} projects={projects} onChange={setProjectPath} />
					<div className="h-4 w-px bg-line" aria-hidden />
					<div className="flex h-7 items-center gap-1 px-1 text-label font-medium text-ink">
						<span>{t("agents.title")}</span>
						<span className="text-caption font-normal text-ink-muted">{count}</span>
					</div>
					<div className="relative w-full @lg:ml-auto @lg:w-64">
						<Search size={16} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted" />
						<Input type="search" value={query} aria-label={t("agents.search")} placeholder={t("agents.search")} onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}
							className={`h-9 w-full rounded-xl border border-[var(--ly-agent-line)] bg-float pl-9 text-label text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-[var(--ly-agent-line-hover)] focus:border-[var(--ly-agent-line-hover)] [&::-webkit-search-cancel-button]:appearance-none ${query ? "pr-9" : "pr-3"}`} />
						{query && <span className="absolute top-1/2 right-1 -translate-y-1/2"><IconButton label={t("common.clear")} onClick={() => setQuery("")} icon={<X size={14} aria-hidden />} /></span>}
					</div>
				</div>

				{catalogue.error && <Banner action={<Button variant="subtle" size="sm" onClick={() => void catalogue.refresh()}>{t("common.retry")}</Button>}>{catalogue.error}</Banner>}
				{error && <Banner>{error}</Banner>}
				{notice && <p role="status" className="px-1 text-label text-ink-muted">{notice} {undo && <button type="button" data-ly-tip={t("common.undo")} aria-label={t("common.undo")} className="inline-grid h-5 w-5 translate-y-[3px] place-items-center rounded-md text-ink hover:bg-[var(--ly-agent-hover)]" onClick={() => { void bridge.agentDefinitions.restore(undo.projectId, undo.token).then(() => { setUndo(null); setNotice(t("agents.restored")); return catalogue.refresh(); }).catch(cause => setError(String(cause))); }}><Undo2 size={12} strokeWidth={2} aria-hidden /></button>}</p>}

				{needle && count === 0 ? <EmptyBox><span className="text-label text-ink-muted">{t("agents.empty")}</span></EmptyBox> : <>
					<section className={needle && installed.length === 0 ? "hidden" : "space-y-4"}>
						<GroupHeader title={t("agents.groupInstalled")} count={installed.length}>
							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" label={t("common.refresh")} disabled={catalogue.busy} onClick={() => void catalogue.refresh()}
									icon={catalogue.busy ? <ActionSpinner size={14} /> : <RefreshCcw size={16} aria-hidden />} />
								<Button variant="primary" size="sm" icon={<Plus size={14} aria-hidden />} onClick={create}>{t("common.new")}</Button>
							</div>
						</GroupHeader>
						{installed.length > 0 ? <AgentList>{installed.map(row)}</AgentList> : <EmptyBox>
							<span className="text-label font-medium text-ink">{t("agents.empty")}</span>
							<span className="text-caption text-ink-muted">{t("agents.emptyDetail")}</span>
							<Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={create}>{t("common.new")}</Button>
						</EmptyBox>}
					</section>
					{builtin.length > 0 && <section className="space-y-4">
						<GroupHeader title={t("agents.groupBuiltin")} count={builtin.length} />
						<AgentList>{builtin.map(row)}</AgentList>
					</section>}
				</>}

				{settings && <section className="space-y-4">
					<GroupHeader title={t("common.session")} />
					<AgentList>
						<SettingRow name="compact" detail={t("agents.compactContext")} profile="compact">
							<ModelSelect ariaLabel={t("agents.compactModel")} showIcon={false} value={agentProfile(settings, "compact").modelId ?? ""} inheritLabel={t("agents.followMain")} inheritedModelId={mainModelId ?? settings.defaultModelId ?? undefined} inheritedSource={t("agents.followMainShort")} disabled={saving}
								onChange={(modelId) => save("compact", modelId ? { modelId } : {})} />
						</SettingRow>
						<SettingRow name={t("agents.sidechatModel")} detail={t("agents.sidechatModelDetail")}>
							<ModelSelect ariaLabel={t("agents.sidechatModel")} showIcon={false} value={settings.sideChatModelId ?? ""} inheritLabel={t("agents.followMain")} inheritedModelId={mainModelId ?? settings.defaultModelId ?? undefined} inheritedSource={t("agents.followMainShort")} inheritDetail={t("agents.sidechatModelDetail")} disabled={saving}
								onChange={(modelId) => { const current = useApp.getState().settings; if (current) void persist({ ...current, sideChatModelId: modelId || null }); }} />
						</SettingRow>
					</AgentList>
				</section>}
			</div>
			{confirm.element}
		</div>
	);
}

function Banner({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
	return <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-label text-danger"><span className="min-w-0">{children}</span>{action}</div>;
}

function EmptyBox({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--ly-agent-line)] px-4 py-10 text-center">{children}</div>;
}

function GroupHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
	const { t } = useI18n();
	return <div className="flex flex-wrap items-center justify-between gap-3">
		<div className="flex min-w-0 items-baseline gap-2 px-1">
			<h2 className="truncate text-label font-medium text-ink">{title}</h2>
			{count !== undefined && <span className="shrink-0 text-label text-ink-faint">{t("agents.itemCount", { n: count })}</span>}
		</div>
		{children}
	</div>;
}

/** 一组行：没有描边的浅面，行与行之间一道 5% 的线。 */
function AgentList({ children }: { children: React.ReactNode }) {
	return <div className="@container overflow-hidden rounded-xl bg-[var(--ly-agent-surface)] [&>*+*]:border-t [&>*+*]:border-[var(--ly-agent-divider)]">{children}</div>;
}

function Badge({ children }: { children: React.ReactNode }) {
	return <span className="inline-flex min-h-5 items-center rounded-md bg-[var(--ly-agent-surface)] px-1.5 py-0.5 text-caption leading-none text-ink-muted ring-1 ring-[var(--ly-agent-line)]">{children}</span>;
}

function AgentRow({ agent, record, avatarOf, saved, disabled, controls, edit, copy, remove }: {
	agent: Agent; record?: AgentDefinitionRecord; avatarOf: AvatarOf;
	/** 刚存下时是存下的时刻，否则 null。 */
	saved: number | null;
	disabled: boolean; controls: React.ReactNode;
	edit?: () => void; copy?: () => void; remove?: () => void;
}) {
	const { t } = useI18n();
	const name = agent.name;
	const highlighted = saved !== null;
	return (
		<div data-agent-profile={name} data-agent-saved={highlighted || undefined} data-ly-avatar-host=""
			className={`relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 transition-colors duration-[var(--ly-t-quick)] @2xl:grid-cols-[auto_minmax(0,1fr)_auto] ${edit && !disabled ? "hover:bg-[var(--ly-agent-hover)]" : ""} ${highlighted ? "bg-info/5" : ""}`}>
			{/*
			 * 整行是编辑入口；但行里还有下拉和按钮，按钮套按钮不成立，所以用一层垫在
			 * 最底下的按钮铺满整行（同 `ListRow`），上面的控件各自先接住自己的点击。
			 */}
			{edit && <button type="button" aria-label={t("agents.editNamed", { name })} disabled={disabled} className="absolute inset-0" onClick={edit} />}
			{/* 设置页、`@` 菜单、面板里都是这张脸，见 `store/agent-avatars.ts`。 */}
			<span className="pointer-events-none relative grid size-9 shrink-0 place-items-center"><AgentAvatar avatar={avatarOf(name)} size={34} seed={name} host="[data-ly-avatar-host]" cheer={saved} /></span>
			<div className="pointer-events-none relative min-w-0">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="truncate text-label font-medium text-ink">{name}</span>
					{agent.source === "workspace" && <Badge>{t("common.project")}</Badge>}
					{record?.customized && <Badge>{t("agents.builtinCustomised")}</Badge>}
					<Badge>{agent.tools === "*" ? t("agents.allTools") : t("agents.toolCount", { n: agent.tools.length })}</Badge>
				</div>
				<p className="mt-0.5 line-clamp-2 text-caption text-ink-muted">{agent.description || t("agents.noDescription")}</p>
			</div>
			<div className="pointer-events-none relative col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-2 @2xl:col-span-1 [&>*]:pointer-events-auto">
				{controls}
				<div className="flex items-center gap-1">
					{copy && <IconButton label={t("agents.duplicateFor", { name })} disabled={disabled} onClick={copy} icon={<Copy size={14} aria-hidden />} />}
					{remove && record && <IconButton label={record.customized ? t(record.scope === "project" ? "agents.removeOverrideFor" : "agents.restoreFor", { name }) : t("agents.deleteFor", { name })}
						disabled={disabled} onClick={remove} icon={record.customized ? <RotateCcw size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />} />}
				</div>
			</div>
		</div>
	);
}

function SettingRow({ name, detail, profile, children }: { name: string; detail: string; profile?: string; children: React.ReactNode }) {
	return <div data-agent-profile={profile} className="grid grid-cols-1 items-center gap-3 px-4 py-3 @2xl:grid-cols-[minmax(0,1fr)_auto]">
		<div className="min-w-0">
			<div className="truncate text-label font-medium text-ink">{name}</div>
			<p className="mt-0.5 text-caption text-ink-muted">{detail}</p>
		</div>
		<div className="flex min-w-0 justify-end">{children}</div>
	</div>;
}

function AgentModelControls({ agent, settings, mainModelId, disabled, onChange }: {
	agent: Pick<Agent, "name" | "model">; settings: Settings; mainModelId?: string | null;
	disabled: boolean; onChange: (profile: SubAgentProfile) => void;
}) {
	const { t } = useI18n();
	const models = availableModels(settings);
	const profile = agentProfile(settings, agent.name);
	const fallback = models.find(({ model }) => model.id === (mainModelId || settings.defaultModelId));
	const selected = profile.modelId ? models.find(({ model }) => model.id === profile.modelId) : undefined;
	const inherited = fallback ? resolveModelRef(withAgentProfile(settings, agent.name, {}), agent.model, fallback) : undefined;
	const current = profile.modelId ? selected : inherited;
	const levels = resolveModelThinkingOptions(current?.model);
	const invalid = profile.modelId && !selected;
	const invalidThinking = profile.thinking && levels.length > 0 && !levels.some((level) => level.id === profile.thinking);
	const inheritedThinking = profile.modelId ? settings.thinking : inherited?.thinking ?? settings.thinking;
	const defaultThinking = resolveThinkingOption(inheritedThinking, current?.model);

	return (
		<fieldset disabled={disabled} aria-label={t("agents.runConfig", { name: agent.name })} className="m-0 flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 border-0 p-0 disabled:opacity-60 [&>button]:max-w-full">
			<ModelSelect ariaLabel={t("agents.modelFor", { name: agent.name })} showIcon={false} value={profile.modelId ?? ""} disabled={disabled} inheritedModelId={inherited?.model.id} inheritedSource={inherited?.via === t("agents.sessionModel") ? t("agents.followMainShort") : t("common.default")}
				inheritLabel={inherited && inherited.via !== t("agents.sessionModel") ? t("agents.followDefinition") : t("agents.followMain")} inheritDetail={inherited ? `${inherited.provider.name} · ${inherited.model.name}` : t("agents.followMain")} onChange={(modelId) => onChange(modelId ? { modelId } : {})} />
			{/* 模型不支持思考时这一格不画——一个点不开的「不支持思考」只是占位。 */}
			{levels.length > 0 && <InlineSelect ariaLabel={t("agents.thinkingFor", { name: agent.name })} value={profile.thinking ?? ""}
				options={[
					{ value: "", label: t("agents.defaultThinking", { level: defaultThinking?.label ?? t("thinking.off") }), icon: <Brain size={14} /> },
					...(invalidThinking && profile.thinking ? [{ value: profile.thinking, label: t("agents.levelUnavailable") }] : []),
					...levels.map((level) => ({ value: level.id, label: level.label, detail: level.detail, icon: <Brain size={14} /> })),
				]} onChange={(thinking) => onChange({ ...profile, thinking: thinking || undefined })} />}
			{(invalid || invalidThinking) && <AlertCircle size={15} className="text-danger" aria-label={t("agents.configUnavailable")} data-ly-tip={t("agents.configUnavailableDetail")} />}
		</fieldset>
	);
}
