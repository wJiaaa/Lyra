import { BUILTIN_AGENTS } from "@plume/core/agents-builtin";
import type { Settings } from "@plume/core";
import { agentProfile, withAgentProfile, availableModels, resolveModelRef, type SubAgentProfile } from "@plume/core/model-roles";
import { resolveModelThinkingOptions, resolveThinkingOption } from "@plume/core/thinking-options";
import { AlertCircle, Brain, Plus, Copy, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store/index.ts";
import { useAgentAvatars, type AvatarOf } from "../../store/agent-avatars.ts";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { Card, InlineSelect } from "./controls.tsx";
import { ModelSelect } from "../models/index.ts";
import { AgentDefinitionEditor } from "./AgentDefinitionEditor.tsx";
import { useAgentDefinitions } from "./useAgentDefinitions.ts";
import { ProjectScope } from "./ProjectScope.tsx";
import type { AgentDefinitionRecord } from "@plume/core";
import { bridge, hostPlatform } from "../../services/index.ts";
import { systemWord } from "../../lib/system-words.ts";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { useI18n } from "../../i18n/index.ts";

type Agent = AgentCapabilities["agents"][number];

/*
 * Laid out like the hooks and commands pages — title and intro, a toolbar of scope, count and
 * search, then 已安装 / 内置 groups in settings cards; a row opens the editor. Its fields are the
 * settings card's own; `e2e/definition-pages-parity.test.ts` holds the four pages to one another.
 */

export function AgentsSettings() {
	const { t } = useI18n();
	const projects = useApp((s) => s.settings?.projects) ?? [];
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const project = projects.find((entry) => entry.path === projectPath) ?? null;
	const catalogue = useAgentDefinitions(project);
	const [editor, setEditor] = useState<{ record?: AgentDefinitionRecord; copy?: boolean; projectId: string | null } | null>(null);
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
			setNotice(result.warning ?? ""); await catalogue.refresh();
		} catch (cause) { setError(String(cause)); }
		finally { setSaving(false); }
	};
	/* Asked the way commands and skills ask: the file goes to the system trash, which is where it comes back from. */
	const askRemove = (record: AgentDefinitionRecord, then?: () => void) => confirm.ask({
		title: t("removal.confirm", { kind: t("removal.agent"), name: record.definition.name }),
		detail: t(systemWord("definitionToTrash", hostPlatform())),
		confirmLabel: t(systemWord("definitionMoveToTrash", hostPlatform())),
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
		<div data-agent-settings className="pt-2">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("agents.title")}</h1>
			<p className="mt-2 text-label text-ink-muted">{t("agents.intro")}</p>
			<div className="mt-6 flex min-w-0 flex-wrap items-center gap-3">
				<ProjectScope value={project} projects={projects} onChange={setProjectPath} />
				<div className="h-4 w-px bg-line" aria-hidden />
				<div className="flex items-center gap-1 text-label font-medium text-ink">
					{t("agents.title")}
					<span className="text-detail font-normal text-ink-faint">{count}</span>
				</div>
				<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={t("agents.search")} className="ml-auto max-w-[220px] flex-1 basis-[120px]" />
			</div>
			<div className="@container">

				{catalogue.error && <Banner action={<Button variant="subtle" size="sm" onClick={() => void catalogue.refresh()}>{t("common.retry")}</Button>}>{catalogue.error}</Banner>}
				{error && <Banner>{error}</Banner>}
				{notice && <p role="status" className="mt-5 text-label text-ink-muted">{notice}</p>}

				{needle && count === 0 ? <section className="mt-6"><Card><p className="px-6 py-10 text-center text-label text-ink-faint">{t("agents.empty")}</p></Card></section> : <>
					<section className={needle && installed.length === 0 ? "hidden" : "mt-6"}>
						<GroupHeader title={t("agents.groupInstalled")} count={installed.length}>
							<div className="flex items-center gap-1.5">
								<Button variant="subtle" size="sm" label={t("common.refresh")} disabled={catalogue.busy} onClick={() => void catalogue.refresh()}
									icon={catalogue.busy ? <ActionSpinner size={13} /> : <RefreshCw size={13} aria-hidden />} />
								<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={create}>{t("common.new")}</Button>
							</div>
						</GroupHeader>
						{installed.length > 0 ? <AgentList>{installed.map(row)}</AgentList> : <Card>
							<div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
								<div className="text-label font-medium text-ink">{t("agents.empty")}</div>
								<p className="max-w-[360px] text-detail text-ink-faint">{t("agents.emptyDetail")}</p>
								<Button variant="primary" className="mt-2" icon={<Plus size={13} aria-hidden />} onClick={create}>{t("common.new")}</Button>
							</div>
						</Card>}
					</section>
					{builtin.length > 0 && <section className="mt-8">
						<GroupHeader title={t("agents.groupBuiltin")} count={builtin.length} />
						<AgentList>{builtin.map(row)}</AgentList>
					</section>}
				</>}

				{settings && <section className="mt-8">
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
	return <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-detail text-danger"><span className="min-w-0">{children}</span>{action}</div>;
}

function GroupHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
	return <div className="mb-4 flex items-center justify-between gap-3">
		<h2 className="flex h-7 items-center gap-1.5 text-label font-medium text-ink">
			{title}
			{count !== undefined && <span className="text-detail font-normal text-ink-faint">{count}</span>}
		</h2>
		{children}
	</div>;
}

/** A group of rows: the settings card, ruled like the hooks and commands lists. */
function AgentList({ children }: { children: React.ReactNode }) {
	return <Card className="@container divide-y divide-line-soft">{children}</Card>;
}

/** What qualifies the name — source, tool count — in the faint text the command rows use for theirs. */
function Meta({ children }: { children: React.ReactNode }) {
	return <span className="shrink-0 text-detail text-ink-faint">{children}</span>;
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
		<div data-agent-profile={name} data-agent-saved={highlighted || undefined} data-ly-avatar-host="" data-row-actions=""
			className={`relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 transition-colors duration-[var(--ly-t-quick)] @2xl:grid-cols-[auto_minmax(0,1fr)_auto] ${edit && !disabled ? "hover:bg-card-hover" : ""} ${highlighted ? "bg-info/5" : ""}`}>
			{/*
			 * 整行是编辑入口；但行里还有下拉和按钮，按钮套按钮不成立，所以用一层垫在
			 * 最底下的按钮铺满整行（同 `ListRow`），上面的控件各自先接住自己的点击。
			 */}
			{edit && <button type="button" aria-label={t("agents.editNamed", { name })} disabled={disabled} className="absolute inset-0" onClick={edit} />}
			{/* 设置页、`@` 菜单、面板里都是这张脸，见 `store/agent-avatars.ts`。 */}
			<span className="pointer-events-none relative grid size-9 shrink-0 place-items-center"><AgentAvatar avatar={avatarOf(name)} size={34} seed={name} host="[data-ly-avatar-host]" cheer={saved} /></span>
			<div className="pointer-events-none relative min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-label font-medium text-ink">{name}</span>
					{agent.source === "workspace" && <Meta>{t("common.project")}</Meta>}
					{record?.customized && <Meta>{t("agents.builtinCustomised")}</Meta>}
					<Meta>{agent.tools === "*" ? t("agents.allTools") : t("agents.toolCount", { n: agent.tools.length })}</Meta>
				</div>
				<p className="mt-1 truncate text-detail text-ink-faint">{agent.description || t("agents.noDescription")}</p>
			</div>
			<div className="pointer-events-none relative col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-2 @2xl:col-span-1 [&>*]:pointer-events-auto">
				{controls}
				<div className="flex items-center gap-1">
					{/* Shown on hover, as a command row's delete and a plugin row's ⋯ are. */}
					{copy && <span className="ly-row-action flex"><IconButton label={t("agents.duplicateFor", { name })} disabled={disabled} onClick={copy} icon={<Copy size={14} aria-hidden />} /></span>}
					{remove && record && <span className="ly-row-action flex"><IconButton label={record.customized ? t(record.scope === "project" ? "agents.removeOverrideFor" : "agents.restoreFor", { name }) : t("agents.deleteFor", { name })}
						disabled={disabled} onClick={remove} icon={record.customized ? <RotateCcw size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />} /></span>}
				</div>
			</div>
		</div>
	);
}

function SettingRow({ name, detail, profile, children }: { name: string; detail: string; profile?: string; children: React.ReactNode }) {
	return <div data-agent-profile={profile} className="grid grid-cols-1 items-center gap-3 px-4 py-3 @2xl:grid-cols-[minmax(0,1fr)_auto]">
		<div className="min-w-0">
			<div className="truncate text-label font-medium text-ink">{name}</div>
			<p className="mt-1 text-detail text-ink-faint">{detail}</p>
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
