import { Check, ChevronRight, Shuffle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentDefinitionRecord, AgentDefinitionSave, AgentDraft } from "@lyra/core";
import { TextArea } from "../../ui/inputs/TextArea.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Disclosure } from "../../ui/layout/Disclosure.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { formatAvatar, freshAvatar, parseAvatar, type Avatar } from "../../lib/agent-avatar.ts";
import type { AvatarOf } from "../../store/agent-avatars.ts";
import { InlineSelect, TextInput } from "./controls.tsx";
import { AvatarPicker, avatarName } from "./AvatarPicker.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";

// Keep unsaved text through settings navigation without writing instructions to browser storage.
const drafts = new Map<string, { draft: AgentDraft; scope: "user" | "project" }>();
const DEFAULT_TOOLS = ["read", "glob", "grep", "ls"];

/*
 * 编辑页照 ZCode 的子智能体表单：面包屑、标题和一句说明，下面一整块描边的表单，
 * 删除在左下，保存、取消在右下。颜色变量见 `styles/fields.css` 的 `[data-agent-settings]`。
 *
 * 脸放在名字旁边，而且新建时就已经挑好了一张没人用的——它是这个智能体在设置页、`@` 菜单、面板
 * 里被认出来的方式，不该是一个等人想起来才去填的空。不满意就点它换，或者掷一次骰子。
 */
export function AgentDefinitionEditor({ record, copy, projectId, projectName, tools, avatarOf, taken, onClose, onDelete, onSaved }: {
	record?: AgentDefinitionRecord; copy?: boolean; projectId: string | null; projectName?: string;
	tools: string[];
	/** 名单里每个人现在的脸，用来给新来的挑一张没人用的。 */
	avatarOf: AvatarOf;
	/** 除了正在编辑的这一个之外，每个人和他在用的脸。 */
	taken: { name: string; avatar: Avatar }[];
	onClose: () => void; onDelete?: () => void; onSaved: (name: string, warning?: string) => void;
}) {
	const { t } = useI18n();
	const definition = record?.definition;
	const draftKey = JSON.stringify([projectId, record?.id ?? "new", Boolean(copy)]);
	const remembered = drafts.get(draftKey);
	// 新建和复制一张新脸（复制出来的是另一个人）；编辑沿用它现在那张。只在第一次渲染时定下来。
	const [initialAvatar] = useState(() => formatAvatar(record && !copy ? avatarOf(record.definition.name) : freshAvatar(taken.map(other => other.avatar))));
	const original: AgentDraft = { name: copy ? `${definition?.name ?? "agent"}-copy` : definition?.name ?? "", description: definition?.description ?? "", systemPrompt: definition?.systemPrompt ?? "", tools: definition?.tools ?? DEFAULT_TOOLS, avatar: initialAvatar };
	const [draft, setDraft] = useState(remembered?.draft ?? original);
	const [scope, setScope] = useState<"user" | "project">(remembered?.scope ?? (record?.scope === "project" && !copy ? "project" : "user"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [leaving, setLeaving] = useState(false);
	const [rolls, setRolls] = useState(0);
	const picker = usePopover();
	const dirty = JSON.stringify(draft) !== JSON.stringify(original) || scope !== (record?.scope === "project" && !copy ? "project" : "user");
	useEffect(() => { if (dirty) drafts.set(draftKey, { draft, scope }); else drafts.delete(draftKey); }, [draftKey, draft, scope, dirty]);
	const discard = () => { drafts.delete(draftKey); onClose(); };
	const leave = () => dirty ? setLeaving(true) : onClose();
	const patch = (next: Partial<AgentDraft>) => setDraft(current => ({ ...current, ...next }));
	const face = parseAvatar(draft.avatar) ?? parseAvatar(initialAvatar) ?? freshAvatar(taken.map(other => other.avatar));
	// 谁在用哪张：选脸的格子据此把别人的那张标出来、不让选，提示里说是谁。
	const owners = useMemo(() => new Map(taken.map(other => [formatAvatar(other.avatar), other.name])), [taken]);
	const editing = Boolean(record && !copy);
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
	return <form data-agent-settings data-agent-editor className="max-w-[800px] space-y-6 pt-2 pb-10" onSubmit={event => { event.preventDefault(); void save(); }}>
		<nav className="-ml-2 flex h-7 min-w-0 items-center text-label">
			{/* 面包屑的第一段就是返回：ZCode 顶栏里那一段，这里没有顶栏，放在页首。 */}
			<Button variant="subtle" size="sm" ariaLabel={t("agentEditor.back")} disabled={busy} onClick={leave}>{t("agents.title")}</Button>
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
					<Button variant="subtle" size="sm" onClick={() => setLeaving(false)}>{t("agentEditor.keepEditing")}</Button>
					<Button variant="danger" size="sm" onClick={discard}>{t("agentEditor.discard")}</Button>
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
				<div className="flex items-end gap-3">
					{/*
					 * 脸是一块能点的底：点它挑，角上那颗骰子直接换一张没人用的。两颗按钮叠在一块底上而不是
					 * 套在一起——按钮里不能再有按钮。
					 */}
					<div className="relative grid h-[56px] w-[56px] shrink-0 place-items-center rounded-[16px] border border-[var(--ly-agent-line)] bg-float transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-hover)]" data-ly-avatar-host="">
						<button type="button" aria-label={t("agentEditor.pickAvatar")} data-ly-tip={`${t("agentEditor.pickAvatar")} · ${avatarName(face, t)}`} aria-haspopup="dialog" aria-expanded={picker.open}
							data-agent-avatar={formatAvatar(face)} onClick={picker.toggle} className="absolute inset-0 rounded-[16px]" />
						<AgentAvatar avatar={face} size={38} seed={draft.name || "new"} host="[data-ly-avatar-host]" cheer={rolls || null} className="pointer-events-none" />
						<IconButton size="sm" label={t("agentEditor.shuffleAvatar")} data-agent-shuffle=""
							onClick={() => { patch({ avatar: formatAvatar(freshAvatar([...taken.map(other => other.avatar), face])) }); setRolls(n => n + 1); }}
							className="absolute -right-2 -bottom-2 bg-shell" icon={<Shuffle size={12} strokeWidth={2} aria-hidden />} />
					</div>
					<label className="block min-w-0 flex-1 @xl:max-w-[14rem]"><FieldLabel>{t("agentEditor.nameLabel")}</FieldLabel>
						<TextInput aria-label={t("agentEditor.callName")} placeholder="code-reviewer" value={draft.name} readOnly={editing} required pattern={editing ? undefined : "[a-z][a-z0-9_-]{0,63}"} onChange={next => patch({ name: next })} />
					</label>
				</div>
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
					{onDelete && <Button variant="danger" icon={<Trash2 size={14} aria-hidden />} className="self-start" onClick={onDelete}>{t("common.delete")}</Button>}
					<div className="flex items-center justify-end gap-2 @sm:ml-auto">
						<Button type="submit" variant="primary" loading={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
						<Button onClick={leave}>{t("common.cancel")}</Button>
					</div>
				</div>
			</fieldset>
		</div>
		{picker.open && <Popover anchor={picker.anchor} onClose={picker.close} placement="bottom" align="start" width={316} label={t("agentEditor.pickAvatar")}>
			<AvatarPicker value={face} owners={owners} onChange={next => { patch({ avatar: formatAvatar(next) }); setRolls(n => n + 1); }} />
		</Popover>}
	</form>;
}

function FieldLabel({ children }: { children: string }) {
	return <span className="mb-1.5 block text-label font-medium text-ink-muted">{children}</span>;
}

/** ZCode 的工具勾选：整格是按钮，勾上是前景色实底。能改文件、跑命令的几样右边一个红点。 */
function ToolCheckbox({ name, checked, onChange }: { name: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return <button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)}
		className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-line)]">
		<span className="flex size-6 shrink-0 items-center justify-center">
			<span className={`flex size-4 items-center justify-center rounded-sm border transition-colors duration-[var(--ly-t-quick)] ${checked ? "border-ink bg-ink text-shell" : "border-[var(--ly-agent-line)] bg-float text-transparent"}`}><Check size={14} strokeWidth={2.4} aria-hidden /></span>
		</span>
		<span className="min-w-0 flex-1 truncate text-label font-medium text-ink">{name}</span>
		{RISKY_TOOLS.has(name) && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />}
	</button>;
}

const RISKY_TOOLS = new Set(["bash", "edit", "write"]);
