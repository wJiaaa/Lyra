/**
 * The parts of an interface block the reader sets: the settings pages' own controls, so a choice in a
 * reply looks and behaves like a choice anywhere else in the app.
 *
 * Every value is the block's state (`InterfaceBlock`); these only show it and report changes. While
 * the block is still being written the whole block is inert there — a control that moves under the
 * cursor as its own options stream in is not one to press yet — and they need not know it.
 */

import { useRef, type ReactNode } from "react";
import { translate } from "../../../i18n/translate.ts";
import { Check } from "../../../ui/icons/index.ts";
import { text } from "@plume/core/ui-language";
import { Button } from "../../../ui/primitives/Button.tsx";
import { Segmented, Select, Slider, TextInput, Toggle } from "../../settings/index.ts";

interface FieldProps {
	value: unknown;
	onChange: (value: unknown) => void;
	label?: string;
}

function Labelled({ label, aside, children }: { label?: string; aside?: ReactNode; children: ReactNode }) {
	return (
		// Not a `<label>`: clicking its words would press the first segment of a choice under it.
		<div data-ly-ui-field="" className="flex min-w-0 flex-col gap-1">
			{(label || aside) && (
				<span className="flex items-baseline justify-between gap-3 text-caption text-ink-muted">
					<span className="truncate">{label}</span>
					{aside}
				</span>
			)}
			{children}
		</div>
	);
}

/** Options as written — strings, numbers, `{label, value}` — as the strings a control works in, and back. */
function optionsOf(options: unknown[] | undefined): { value: string; label: string; original: unknown }[] {
	return (options ?? []).map((option) => {
		if (option && typeof option === "object" && !Array.isArray(option)) {
			const record = option as Record<string, unknown>;
			const original = record.value ?? record.label;
			return { value: text(original), label: text(record.label ?? original), original };
		}
		return { value: text(option), label: text(option), original: option };
	});
}

export function InputField({ value, onChange, label, placeholder, numeric }: FieldProps & { placeholder?: string; numeric: boolean }) {
	return (
		<Labelled label={label}>
			<TextInput
				value={text(value)}
				placeholder={placeholder}
				inputMode={numeric ? "decimal" : undefined}
				aria-label={label}
				onChange={(next) => {
					const number = Number(next);
					onChange(numeric && next.trim() !== "" && Number.isFinite(number) ? number : next);
				}}
			/>
		</Labelled>
	);
}

export function SelectField({ value, onChange, label, options }: FieldProps & { options?: unknown[] }) {
	const choices = optionsOf(options);
	if (!choices.length) return null;
	const current = choices.find((choice) => choice.value === text(value)) ?? choices[0]!;
	return (
		<Labelled label={label}>
			<Select value={current.value} options={choices} ariaLabel={label} onChange={(next) => onChange(choices.find((choice) => choice.value === next)?.original)} />
		</Labelled>
	);
}

export function ChoiceField({ value, onChange, label, options, multiple }: FieldProps & { options?: unknown[]; multiple: boolean }) {
	const choices = optionsOf(options);
	if (!choices.length) return null;
	if (!multiple)
		return (
			<Labelled label={label}>
				<div className="w-fit max-w-full overflow-x-auto">
					<Segmented value={text(value)} options={choices} onChange={(next) => onChange(choices.find((choice) => choice.value === next)?.original)} />
				</div>
			</Labelled>
		);
	const picked = Array.isArray(value) ? value.map(text) : [];
	return (
		<Labelled label={label}>
			<div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
				{choices.map((choice) => {
					const on = picked.includes(choice.value);
					return (
						<Button
							key={choice.value}
							size="sm"
							pressed={on}
							onClick={() => onChange(on ? choices.filter((other) => other.value !== choice.value && picked.includes(other.value)).map((other) => other.original) : choices.filter((other) => other.value === choice.value || picked.includes(other.value)).map((other) => other.original))}
						>
							{choice.label}
						</Button>
					);
				})}
			</div>
		</Labelled>
	);
}

export function SliderField({ value, onChange, label, min = 0, max = 100, step = 1, unit }: FieldProps & { min?: number; max?: number; step?: number; unit?: string }) {
	const number = typeof value === "number" ? value : Number(value) || min;
	return (
		<Labelled label={label} aside={<span className="text-ink tabular-nums">{`${number}${unit ?? ""}`}</span>}>
			<div className="py-1">
				<Slider value={number} min={min} max={max} step={step > 0 ? step : 1} width="100%" label={label ?? ""} onChange={onChange} />
			</div>
		</Labelled>
	);
}

export function ToggleField({ value, onChange, label }: FieldProps) {
	return (
		<div className="flex min-w-0 items-center justify-between gap-3">
			<span className="truncate text-label text-ink">{label}</span>
			<Toggle checked={value === true} onChange={onChange} ariaLabel={label} />
		</div>
	);
}

/** Pressed twice in the time it takes to see the first one go, it would say the same thing twice. */
const PRESS_GAP_MS = 1500;

/**
 * `sent`: what it would say has been said, and nothing set since has changed it. It says so in place of
 * its label until a value changes, and takes no press meanwhile — the same words again are a repeat,
 * not an answer.
 */
export function ActionButton({ primary, sent, disabled, onPress, children }: { primary: boolean; sent: boolean; disabled: boolean; onPress: () => void; children: ReactNode }) {
	const last = useRef(0);
	if (sent)
		return (
			// A status, not a disabled button: a faded button reads as broken, and this is the press having worked.
			// The button's own height, so the block does not move when it is pressed.
			<span role="status" data-ly-ui-sent="" className="inline-flex h-[32px] w-fit items-center gap-1.5 text-label text-ink-muted">
				<Check size={13} strokeWidth={2} aria-hidden />
				{translate("interface.sent")}
			</span>
		);
	return (
		<Button
			variant={primary ? "primary" : "ghost"}
			disabled={disabled}
			className="w-fit"
			onClick={() => {
				const now = Date.now();
				if (now - last.current < PRESS_GAP_MS) return;
				last.current = now;
				onPress();
			}}
		>
			{children}
		</Button>
	);
}
