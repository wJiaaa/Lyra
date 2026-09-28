/**
 * 新建和编辑一条钩子。字段：事件、运行方式、范围、匹配器、命令，
 * 进程型再加参数，Shell 型再加 shell 和后台运行；超时、状态消息和原样保留的自定义字段收在「高级」里。
 */

import type { HookDraft, HookEventName, HookScope } from "@plume/core";
import { ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import type { HookView } from "../../../electron/ipc-types.ts";
import { useI18n } from "../../i18n/index.ts";
import { TextArea } from "../../ui/inputs/TextArea.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { Toggle } from "./controls.tsx";
import { Select, TextInput } from "./inputs.tsx";
import { Card, Field } from "./layout.tsx";

const EVENTS: HookEventName[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"];

function parseCustom(text: string): Record<string, unknown> | undefined | null {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function HookForm({
	hook,
	scopes,
	defaultScope,
	onSave,
	onCancel,
	onDelete,
}: {
	hook?: HookView;
	/** 能存到哪几处。没打开项目时只有用户级。 */
	scopes: { value: HookScope; label: string }[];
	defaultScope: HookScope;
	onSave: (scope: HookScope, draft: HookDraft) => Promise<void>;
	onCancel: () => void;
	onDelete?: () => void;
}) {
	const { t } = useI18n();
	const [scope, setScope] = useState<HookScope>(hook?.scope ?? defaultScope);
	const [event, setEvent] = useState<HookEventName>(hook?.event ?? "PreToolUse");
	const [type, setType] = useState<HookDraft["type"]>(hook?.type ?? "process");
	const [matcher, setMatcher] = useState(hook?.matcher ?? "");
	const [command, setCommand] = useState(hook?.command ?? "");
	const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
	const [background, setBackground] = useState(hook?.async ?? false);
	const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
	const [timeoutText, setTimeoutText] = useState(hook?.timeout === undefined ? "" : String(hook.timeout));
	const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
	const [customJson, setCustomJson] = useState(hook?.custom ? JSON.stringify(hook.custom, null, 2) : "");
	const [saving, setSaving] = useState(false);

	const custom = parseCustom(customJson);
	const canSave = Boolean(command.trim()) && custom !== null && !saving;

	async function save() {
		if (!canSave) return;
		const seconds = Number.parseInt(timeoutText, 10);
		setSaving(true);
		try {
			await onSave(scope, {
				event,
				...(matcher.trim() ? { matcher: matcher.trim() } : {}),
				type,
				command: command.trim(),
				...(type === "process"
					? { args: args.split("\n").map((arg) => arg.trim()).filter(Boolean) }
					: {
							async: background,
							// 设置文件里写的是 `shell: true`（用系统默认的那个）时，框里是空的，存回去仍是 true。
							...(shell.trim() ? { shell: shell.trim() } : hook?.shell === true ? { shell: true as const } : {}),
						}),
				...(statusMessage.trim() ? { statusMessage: statusMessage.trim() } : {}),
				...(seconds > 0 ? { timeout: seconds } : {}),
				enabled: hook?.enabled ?? true,
				...(custom ? { custom } : {}),
			});
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="pt-2" data-ly-hook-form="">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{hook ? t("hooks.edit") : t("hooks.add")}</h1>
			<p className="mt-2 text-label text-ink-muted">{t("hooks.intro")}</p>

			<Card className="mt-6 space-y-4 p-4">
				<div className="grid gap-3 sm:grid-cols-3">
					<Field label={t("hooks.event")}>
						<Select value={event} onChange={setEvent} options={EVENTS.map((name) => ({ value: name, label: name }))} ariaLabel={t("hooks.event")} />
					</Field>
					<Field label={t("hooks.type")}>
						<Select
							value={type}
							onChange={setType}
							options={[
								{ value: "process", label: t("hooks.typeProcess") },
								{ value: "command", label: t("hooks.typeCommand") },
							]}
							ariaLabel={t("hooks.type")}
						/>
					</Field>
					<Field label={t("hooks.scope")}>
						{/* 编辑时不能换范围：换过去就是另一个文件里的另一条了，先删再建说得更清楚。 */}
						{hook ? (
							<div className="ly-field w-full text-ink-muted">{scopes.find((entry) => entry.value === hook.scope)?.label ?? hook.scope}</div>
						) : (
							<Select value={scope} onChange={setScope} options={scopes} ariaLabel={t("hooks.scope")} />
						)}
					</Field>
				</div>

				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={t("hooks.matcher")} hint={t("hooks.matcherHint")}>
						<TextInput value={matcher} onChange={setMatcher} placeholder={t("hooks.matcherPlaceholder")} />
					</Field>
					<Field label={t("hooks.command")}>
						<TextInput value={command} onChange={setCommand} placeholder={t("hooks.commandPlaceholder")} mono />
					</Field>
				</div>

				{type === "process" ? (
					<Field label={t("hooks.args")} hint={t("hooks.argsHint")}>
						<TextArea value={args} onChange={setArgs} rows={4} className="font-mono" resizable />
					</Field>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("hooks.shell")}>
							<TextInput value={shell} onChange={setShell} placeholder={t("hooks.shellPlaceholder")} mono />
						</Field>
						<div className="flex items-end justify-between gap-4 pb-1.5">
							<span className="text-label text-ink-muted">{t("hooks.async")}</span>
							<Toggle checked={background} onChange={setBackground} ariaLabel={t("hooks.async")} />
						</div>
					</div>
				)}

				<details className="group/advanced border-t border-line-soft pt-3">
					<summary className="flex cursor-pointer list-none items-center gap-1 text-label text-ink-muted">
						<ChevronRight size={14} className="transition-transform group-open/advanced:rotate-90" aria-hidden />
						{t("hooks.advanced")}
					</summary>
					<div className="mt-3 space-y-3">
						<div className="grid gap-3 sm:grid-cols-2">
							<Field label={t("hooks.timeout")} hint={t("hooks.timeoutHint")}>
								<TextInput value={timeoutText} onChange={setTimeoutText} inputMode="numeric" placeholder="60" className="w-28" />
							</Field>
							<Field label={t("hooks.statusMessage")}>
								<TextInput value={statusMessage} onChange={setStatusMessage} placeholder={t("hooks.statusMessagePlaceholder")} />
							</Field>
						</div>
						<Field label={t("hooks.customJson")} hint={custom === null ? t("hooks.customJsonError") : undefined}>
							<TextArea value={customJson} onChange={setCustomJson} rows={5} className="font-mono" placeholder={'{\n  "customKey": "value"\n}'} resizable />
						</Field>
					</div>
				</details>

				<div className="flex items-center gap-2 border-t border-line-soft pt-4">
					{onDelete && (
						<Button variant="danger" icon={<Trash2 size={13} aria-hidden />} onClick={onDelete}>
							{t("common.delete")}
						</Button>
					)}
					<div className="ml-auto flex items-center gap-2">
						<Button variant="ghost" onClick={onCancel}>
							{t("common.cancel")}
						</Button>
						<Button variant="primary" disabled={!canSave} loading={saving} onClick={() => void save()}>
							{t("common.save")}
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
