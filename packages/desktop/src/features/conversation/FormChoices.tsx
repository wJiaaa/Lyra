import { translate } from "../../i18n/translate.ts";
import type { MessageKey } from "../../i18n/messages/index.ts";
import { Check, X } from "../../ui/icons/index.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision } from "@plume/core";
import { checkFormValues, initialValues, type FormField, type FormProblem } from "@plume/core/mcp-form";
import { Input } from "../../ui/inputs/NativeField.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { ChoiceMark } from "../../ui/primitives/ChoiceMark.tsx";

/** 输入框里留着人打的原样文字；交之前才换成表单要的类型，换不过去的交给检查去说「不是数字」。 */
type Draft = Record<string, string | boolean | number | undefined>;

const PROBLEM: Record<FormProblem, MessageKey> = {
	required: "form.problem.required",
	type: "form.problem.type",
	option: "form.problem.option",
	format: "form.problem.format",
	minLength: "form.problem.minLength",
	maxLength: "form.problem.maxLength",
	minimum: "form.problem.minimum",
	maximum: "form.problem.maximum",
};

function rowTone(on: boolean): string {
	// 和提问卡（`QuestionChoices`）的选项行同一套底色：同一个卡片体系里，单选长得一样。
	// `relative` 让 `sr-only` 的 input 跟着行滚，理由见 `QuestionChoices` 的 `rowTone`。
	return `group relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-label transition-colors duration-[var(--ly-t-quick)] ${on ? "bg-accent/[0.08]" : "bg-card hover:bg-card-hover"}`;
}

function collect(fields: readonly FormField[], draft: Draft): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) {
		const raw = draft[field.name];
		if (typeof raw !== "string") { values[field.name] = raw; continue; }
		const text = raw.trim();
		if (!text) continue;
		if (field.type === "number" || field.type === "integer") {
			const number = Number(text);
			values[field.name] = Number.isFinite(number) ? number : text;
		} else if (field.format === "date-time") {
			// `datetime-local` 给的是不带时区的本地时刻，规范要的是 RFC 3339：按本机时区换成 UTC。
			const at = new Date(text);
			values[field.name] = Number.isNaN(at.getTime()) ? text : at.toISOString();
		} else values[field.name] = raw;
	}
	return values;
}

function inputType(field: FormField): string {
	if (field.format === "email") return "email";
	if (field.format === "uri") return "url";
	if (field.format === "date") return "date";
	if (field.format === "date-time") return "datetime-local";
	return "text";
}

function problemText(field: FormField, problem: FormProblem): string {
	return translate(PROBLEM[problem], {
		kind: translate(field.type === "integer" ? "form.kind.integer" : field.type === "number" ? "form.kind.number" : "form.kind.text"),
		format: field.format ?? "",
		n: String(problem === "minLength" ? field.minLength : problem === "maxLength" ? field.maxLength : problem === "minimum" ? field.minimum : field.maximum),
	});
}

/**
 * MCP 服务器要人填的一张表（elicitation）。
 *
 * 三个出口对应协议的三种回答，不能并成两个：「拒绝」是人明确说不给（decline），「取消」是人没做
 * 决定就把它关了（cancel）——服务器据此决定是放弃还是过会儿再问。
 */
export function FormChoices({ fields, children, answer }: {
	fields: readonly FormField[];
	children?: ReactNode;
	answer(decision: ApprovalDecision): Promise<void>;
}) {
	const [draft, setDraft] = useState<Draft>(() => initialValues(fields));
	const [tried, setTried] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const submitting = useRef(false);
	const formRef = useRef<HTMLFormElement>(null);
	const checked = checkFormValues(fields, collect(fields, draft));
	// 没点过提交之前不报错：一张刚弹出来的表满是红字，人还没开始填就像是填错了。
	const problems = tried && !checked.ok ? checked.problems : {};

	useEffect(() => { formRef.current?.querySelector<HTMLElement>("input")?.focus(); }, []);

	function set(name: string, value: string | boolean | undefined) {
		setDraft(current => ({ ...current, [name]: value }));
	}
	async function submit(decision: ApprovalDecision) {
		if (submitting.current) return;
		submitting.current = true;
		setPending(true); setError("");
		try { await answer(decision); }
		catch (failure) {
			submitting.current = false;
			setPending(false);
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}

	return <form ref={formRef} data-ly-mcp-form="" className="flex min-h-0 flex-1 flex-col" aria-busy={pending} noValidate
		onSubmit={event => {
			event.preventDefault();
			setTried(true);
			if (checked.ok) void submit({ values: checked.values });
		}}>
		<Scroller className="ly-approval-scroll min-h-0 max-h-[min(360px,40dvh)]" top="fade" bottom="fade" contentClassName="px-4 py-2">
			{children}
			<fieldset disabled={pending} className="mt-3 flex min-w-0 flex-col gap-3">
				{fields.map(field => {
					const problem = problems[field.name];
					const id = `ly-form-${field.name}`;
					const label = <span className="text-label text-ink">
						{field.label}
						{field.required && <span className="ml-1 text-caption text-ink-faint">{translate("form.required")}</span>}
					</span>;
					const hint = field.description && <span className="text-caption leading-relaxed text-ink-muted">{field.description}</span>;
					const note = problem && <span role="alert" data-ly-form-problem={field.name} className="text-caption text-danger">{problemText(field, problem)}</span>;
					if (field.type === "boolean") {
						const on = draft[field.name] === true;
						return <div key={field.name} data-ly-form-field={field.name} className="flex flex-col gap-1">
							<label className={rowTone(on)}>
								<input type="checkbox" className="sr-only" checked={on} onChange={event => set(field.name, event.target.checked)} />
								<ChoiceMark checked={on} kind="checkbox" />
								<span className="flex min-w-0 flex-1 flex-col">{label}{hint}</span>
							</label>
							{note}
						</div>;
					}
					if (field.options) {
						return <fieldset key={field.name} data-ly-form-field={field.name} className="flex min-w-0 flex-col gap-1.5">
							<legend className="mb-1 flex flex-col">{label}{hint}</legend>
							{field.options.map(option => {
								const on = draft[field.name] === option.value;
								// 可选的单选再点一下就是不选：radio 本身退不回去，而「没填」对服务器是另一种回答。
								return <label key={option.value} data-ly-form-option={option.value} className={rowTone(on)}>
									<input type="radio" name={id} className="sr-only" checked={on} onChange={() => set(field.name, option.value)}
										onClick={() => { if (on && !field.required) set(field.name, undefined); }} />
									<ChoiceMark checked={on} kind="radio" />
									<span className="min-w-0 flex-1 break-words text-ink">{option.label}</span>
								</label>;
							})}
							{note}
						</fieldset>;
					}
					const numeric = field.type === "number" || field.type === "integer";
					const value = draft[field.name];
					return <div key={field.name} data-ly-form-field={field.name} className="flex flex-col gap-1">
						<label htmlFor={id} className="flex flex-col">{label}{hint}</label>
						<Input id={id} type={numeric ? "text" : inputType(field)} inputMode={field.type === "integer" ? "numeric" : field.type === "number" ? "decimal" : undefined}
							value={value === undefined ? "" : String(value)} aria-invalid={problem ? true : undefined}
							onChange={event => set(field.name, event.target.value)}
							className={`h-8 min-w-0 rounded-md border bg-shell px-2.5 text-label text-ink placeholder:text-ink-faint ${problem ? "border-danger" : "border-line"}`} />
						{note}
					</div>;
				})}
			</fieldset>
		</Scroller>
		<div className="shrink-0 px-4 pb-3 pt-1">
			<div className="flex flex-wrap items-center justify-end gap-2">
				<Button variant="subtle" disabled={pending} onClick={() => void submit("reject")} className="mr-auto" icon={<X size={14} />}>{translate("form.decline")}</Button>
				<Button variant="subtle" disabled={pending} onClick={() => void submit("cancel")}>{translate("common.cancel")}</Button>
				<Button type="submit" variant="primary" disabled={pending} icon={<Check size={14} />}>{translate("form.submit")}</Button>
			</div>
			{error && <p role="alert" className="mt-2 break-words text-caption text-danger">{error}</p>}
		</div>
	</form>;
}
