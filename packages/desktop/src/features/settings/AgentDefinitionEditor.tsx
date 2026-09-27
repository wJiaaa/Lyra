import { Check, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentDefinitionRecord, AgentDefinitionSave, AgentDraft } from "@lyra/core";
import { TextArea } from "../../ui/inputs/TextArea.tsx";
import { Disclosure } from "../../ui/layout/Disclosure.tsx";
import { InlineSelect, TextInput } from "./controls.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";

// Keep unsaved text through settings navigation without writing instructions to browser storage.
const drafts = new Map<string, { draft: AgentDraft; scope: "user" | "project" }>();
const DEFAULT_TOOLS = ["read", "glob", "grep", "ls"];

/** ZCode 的主按钮：前景色实底，字用页面色——暗色下白底黑字，浅色下反过来。列表页也用它。 */
export const AGENT_PRIMARY_BUTTON = "inline-flex shrink-0 items-center justify-center gap-1 rounded-lg bg-ink text-label text-shell transition-colors duration-[var(--ly-t-quick)] hover:bg-ink/80 disabled:pointer-events-none disabled:opacity-50";
const GHOST_BUTTON = "inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2.5 text-label text-ink transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-hover)] disabled:pointer-events-none disabled:opacity-50";

/*
 * 编辑页照 ZCode 的子智能体表单：面包屑、标题和一句说明，下面一整块描边的表单，
 * 删除在左下，保存、取消在右下。颜色变量见 `styles/fields.css` 的 `[data-agent-settings]`。
 */
export function AgentDefinitionEditor({ record, copy, projectId, projectName, tools, onClose, onDelete, onSaved }: {
	record?: AgentDefinitionRecord; copy?: boolean; projectId: string | null; projectName?: string;
	tools: string[]; onClose: () => void; onDelete?: () => void; onSaved: (name: string, warning?: string) => void;
}) {
	const { t } = useI18n();
	const definition = record?.definition;
	const original: AgentDraft = { name: copy ? `${definition?.name ?? "agent"}-copy` : definition?.name ?? "", description: definition?.description ?? "", systemPrompt: definition?.systemPrompt ?? "", tools: definition?.tools ?? DEFAULT_TOOLS };
	const draftKey = JSON.stringify([projectId, record?.id ?? "new", Boolean(copy)]);
	const remembered = drafts.get(draftKey);
	const [draft, setDraft] = useState(remembered?.draft ?? original);
	const [scope, setScope] = useState<"user" | "project">(remembered?.scope ?? (record?.scope === "project" && !copy ? "project" : "user"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [leaving, setLeaving] = useState(false);
	const editing = Boolean(record && !copy);
	const dirty = JSON.stringify(draft) !== JSON.stringify(original) || scope !== (record?.scope === "project" && !copy ? "project" : "user");
	useEffect(() => { if (dirty) drafts.set(draftKey, { draft, scope }); else drafts.delete(draftKey); }, [draftKey, draft, scope, dirty]);
	const discard = () => { drafts.delete(draftKey); onClose(); };
	const leave = () => dirty ? setLeaving(true) : onClose();
	const patch = (next: Partial<AgentDraft>) => setDraft(current => ({ ...current, ...next }));
	const save = async () => {
		if (busy) return;
		setBusy(true); setError("");
		try {
			const input: AgentDefinitionSave = { scope, draft, ...record ? copy ? { copyFrom: record.id } : { id: record.id, revision: record.revision } : {} };
			const result = await bridge.agentDefinitions.save(projectId, input);
			drafts.delete(draftKey); onSaved(draft.name, result.warning);
		} catch (cause) { setError(String(cause)); }
		finally { setBusy(false); }
	};
	const title = editing && record ? t("agentEditor.editNamed", { name: record.definition.name }) : t("agents.add");
	const selected = draft.tools;
	return <form data-agent-settings data-agent-editor className="max-w-[800px] space-y-6 pt-8 pb-10" onSubmit={event => { event.preventDefault(); void save(); }}>
		<nav className="-ml-2 flex h-7 min-w-0 items-center text-label">
			{/* 面包屑的第一段就是返回：ZCode 顶栏里那一段，这里没有顶栏，放在页首。 */}
			<button type="button" aria-label={t("agentEditor.back")} disabled={busy} className="h-7 min-w-0 shrink rounded-lg px-2 text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-hover)] hover:text-ink" onClick={leave}>{t("agents.title")}</button>
			<ChevronRight size={14} aria-hidden className="shrink-0 text-ink-faint" />
			<span className="truncate px-2 text-ink">{editing && record ? record.definition.name : t("agents.add")}</span>
		</nav>
		<div className="@container space-y-4">
			<div className="space-y-1">
				<h1 className="text-title font-semibold text-ink">{title}</h1>
				<p className="text-label text-ink-muted">{record?.scope === "builtin" && !copy ? t("agentEditor.saveAsCustom") : t("agentEditor.intro")}</p>
			</div>
			{leaving && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ly-agent-line)] px-3 py-2 text-label text-ink">
				{t("agentEditor.unsaved")}
				<div className="flex items-center gap-2">
					<button type="button" className={`${GHOST_BUTTON} h-7 px-2`} onClick={() => setLeaving(false)}>{t("agentEditor.keepEditing")}</button>
					<button type="button" className={`${GHOST_BUTTON} h-7 px-2 text-danger`} onClick={discard}>{t("agentEditor.discard")}</button>
				</div>
			</div>}
			{error && <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-label text-danger">{error}</div>}
			<fieldset disabled={busy} className="m-0 min-w-0 space-y-3 rounded-xl border border-[var(--ly-agent-line)] p-4 disabled:opacity-60">
				<div className="flex justify-end">
					<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
						<span className="shrink-0 text-label text-ink-muted">{t("agentEditor.scopeLabel")}</span>
						<fieldset disabled={editing} className="m-0 border-0 p-0"><InlineSelect ariaLabel={t("agentEditor.scope")} value={scope} options={[{ value: "user", label: t("common.allProjects") }, ...(projectId ? [{ value: "project", label: projectName ?? t("common.currentProject") }] : [])]} onChange={value => { if (value === "project" || value === "user") setScope(value); }} /></fieldset>
					</div>
				</div>
				<label className="block @xl:max-w-[14rem]"><FieldLabel>{t("agentEditor.nameLabel")}</FieldLabel>
					<TextInput aria-label={t("agentEditor.callName")} placeholder="code-reviewer" value={draft.name} readOnly={editing} required pattern={editing ? undefined : "[a-z][a-z0-9_-]{0,63}"} onChange={next => patch({ name: next })} />
				</label>
				<label className="block"><FieldLabel>{t("agentEditor.purposeLabel")}</FieldLabel>
					<TextInput aria-label={t("agentEditor.purpose")} placeholder={t("agentEditor.purposePlaceholder")} required maxLength={2000} value={draft.description} onChange={next => patch({ description: next })} />
				</label>
				<div className="space-y-2 pt-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<InlineSelect ariaLabel={t("agentEditor.allowedTools")} value={selected === "*" ? "all" : "custom"}
							options={[{ value: "all", label: t("agentEditor.allTools") }, { value: "custom", label: t("agentEditor.customTools") }]}
							onChange={value => patch({ tools: value === "all" ? "*" : selected === "*" ? DEFAULT_TOOLS : selected })} />
						<span className="min-w-0 text-label text-ink-muted">{t("agentEditor.toolsNote")}</span>
					</div>
					{selected !== "*" && <div className="rounded-lg border border-[var(--ly-agent-line)] bg-float p-1">
						<div className="grid max-h-72 gap-1 overflow-y-auto @md:grid-cols-2 @2xl:grid-cols-3">
							{[...new Set([...tools, ...selected])].map(name => <ToolCheckbox key={name} name={name} checked={selected.includes(name)}
								onChange={checked => patch({ tools: checked ? [...selected, name] : selected.filter(tool => tool !== name) })} />)}
						</div>
					</div>}
				</div>
				<label className="block"><FieldLabel>{t("agentEditor.instructionsLabel")}</FieldLabel>
					<TextArea aria-label={t("agentEditor.instructions")} placeholder={t("agentEditor.instructionsPlaceholder")} required maxLength={200000} value={draft.systemPrompt} rows={8} resizable className="min-h-16" onChange={next => patch({ systemPrompt: next })} />
				</label>
				{definition && <div className="text-label"><Disclosure variant="framed" title={t("agentEditor.advanced")}><p className="mb-2 text-detail text-ink-muted">{t("agentEditor.advancedNote")}</p><pre className="overflow-auto whitespace-pre-wrap break-words text-caption">{JSON.stringify({ model: definition.model, output: definition.output, schemaMode: definition.schemaMode, spawns: definition.spawns }, null, 2)}</pre></Disclosure></div>}
				<p className="text-caption text-ink-muted">{t("agentEditor.draftNote")}</p>
				<div className="flex flex-col gap-2 pt-1 @sm:flex-row @sm:items-center">
					{onDelete && <button type="button" className="inline-flex h-8 items-center gap-1 self-start text-label text-danger underline-offset-4 hover:underline" onClick={onDelete}><Trash2 size={14} aria-hidden />{t("common.delete")}</button>}
					<div className="flex items-center justify-end gap-2 @sm:ml-auto">
						<button type="submit" className={`${AGENT_PRIMARY_BUTTON} h-8 px-2.5`}>{busy ? t("common.saving") : t("common.save")}</button>
						<button type="button" className={GHOST_BUTTON} onClick={leave}>{t("common.cancel")}</button>
					</div>
				</div>
			</fieldset>
		</div>
	</form>;
}

function FieldLabel({ children }: { children: string }) {
	return <span className="mb-1.5 block text-label font-medium text-ink-muted">{children}</span>;
}

/** ZCode 的工具勾选：整格是按钮，勾上是前景色实底。能改文件、跑命令的几样右边一个红点。 */
function ToolCheckbox({ name, checked, onChange }: { name: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return <button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)}
		className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-line)]">
		<span className="flex size-6 shrink-0 items-center justify-center">
			<span className={`flex size-4 items-center justify-center rounded-sm border transition-colors duration-[var(--ly-t-quick)] ${checked ? "border-ink bg-ink text-shell" : "border-[var(--ly-agent-line)] bg-float text-transparent"}`}><Check size={14} strokeWidth={2.4} aria-hidden /></span>
		</span>
		<span className="min-w-0 flex-1 truncate text-label font-medium text-ink">{name}</span>
		{RISKY_TOOLS.has(name) && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />}
	</button>;
}

const RISKY_TOOLS = new Set(["bash", "edit", "write"]);
