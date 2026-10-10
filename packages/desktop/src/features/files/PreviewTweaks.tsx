import { useState, type ReactNode } from "react";
import { translate } from "../../i18n/translate.ts";
import { Check, Eye, RotateCcw } from "../../ui/icons/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { ColorField, Select, Slider, Toggle } from "../settings/index.ts";
import type { TweakControl, TweakGroup, TweakValue } from "../../../shared/preview.ts";

function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="flex items-baseline justify-between gap-3 text-caption text-ink-muted">
				<span className="truncate">{label}</span>
				{aside}
			</span>
			{children}
		</div>
	);
}

function Control({ control, value, onChange }: { control: TweakControl; value: TweakValue; onChange: (value: unknown) => void }) {
	switch (control.kind) {
		case "slider":
			return (
				<Field label={control.label} aside={<span className="text-ink tabular-nums">{`${String(value)}${control.unit}`}</span>}>
					<div className="py-1">
						<Slider value={Number(value)} min={control.min} max={control.max} step={control.step} width="100%" label={control.label} onChange={onChange} />
					</div>
				</Field>
			);
		case "color":
			return (
				<Field label={control.label}>
					<div className="w-fit">
						<ColorField value={String(value)} label={control.label} onChange={(next) => onChange(next.toLowerCase())} />
					</div>
				</Field>
			);
		case "toggle":
			// Label above, as its neighbours have theirs: in a grid of them a label beside the switch sat on another line.
			return (
				<Field label={control.label}>
					<div className="flex h-[30px] items-center">
						<Toggle checked={value === true} onChange={onChange} ariaLabel={control.label} />
					</div>
				</Field>
			);
		case "select":
			return (
				<Field label={control.label}>
					<Select value={String(value)} options={control.options} ariaLabel={control.label} onChange={onChange} />
				</Field>
			);
	}
}

/**
 * The design controls a page offered, under the page.
 *
 * Under it, not over it: the reader is adjusting the page and has to see all of it while they do.
 * The app's own controls, as an interface block's are (`features/conversation/interface/controls.tsx`),
 * so a slider here is the slider everywhere else. Moving one changes the page at once and costs
 * nothing; only the last button says anything to the model, and only what was changed.
 *
 * A bordered box with no shadow: it sits in the conversation, not above it, and the page above it
 * has no edge of its own to lean on (see `PreviewCard`).
 */
export function PreviewTweaks({ groups, current, changed, sent, onSet, onReset, onPeek, onSend }: {
	groups: TweakGroup[];
	current: (control: TweakControl) => TweakValue;
	changed: number;
	/** What the button would send has been sent, and nothing has moved since. */
	sent: boolean;
	onSet: (control: TweakControl, value: unknown) => void;
	onReset: () => void;
	onPeek: (original: boolean) => void;
	onSend: () => void;
}) {
	const [peeking, setPeeking] = useState(false);
	const peek = (on: boolean) => {
		setPeeking(on);
		onPeek(on);
	};
	// Moving a control while looking at the original is going back to adjusting.
	const set = (control: TweakControl, value: unknown) => {
		if (peeking) peek(false);
		onSet(control, value);
	};
	const titled = groups.length > 1 || Boolean(groups[0]?.label);
	return (
		<section aria-label={translate("preview.tweak")} data-ly-preview-tweaks="" className="ly-enter mb-2.5 flex flex-col gap-4 rounded-[12px] border border-line-soft px-4 py-3">
			{groups.map((group, index) => (
				<div key={index} className="flex flex-col gap-2.5">
					{titled && <h4 className="text-label font-medium text-ink">{group.label}</h4>}
					<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-3">
						{group.controls.map((control) => (
							<Control key={control.id} control={control} value={current(control)} onChange={(value) => set(control, value)} />
						))}
					</div>
				</div>
			))}
			<div className="flex flex-wrap items-center justify-end gap-1.5">
				<Button size="sm" icon={<RotateCcw size={13} strokeWidth={1.9} />} disabled={changed === 0} onClick={() => { if (peeking) peek(false); onReset(); }}>
					{translate("preview.tweak.reset")}
				</Button>
				<Button size="sm" icon={<Eye size={13} strokeWidth={1.9} />} disabled={changed === 0} pressed={peeking} onClick={() => peek(!peeking)}>
					{translate("preview.tweak.original")}
				</Button>
				{sent ? (
					// The button's own height, so the row does not move when it is pressed. As an interface block's `send`.
					<span role="status" className="inline-flex h-[26px] items-center gap-1.5 px-2 text-label text-ink-muted">
						<Check size={13} strokeWidth={2} aria-hidden />
						{translate("interface.sent")}
					</span>
				) : (
					<Button size="sm" variant="primary" disabled={changed === 0} onClick={() => { if (peeking) peek(false); onSend(); }}>
						{translate("preview.tweak.send")}
					</Button>
				)}
			</div>
		</section>
	);
}
