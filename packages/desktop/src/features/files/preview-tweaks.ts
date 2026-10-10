import { useEffect, useRef, useState, type RefObject } from "react";
import { translate } from "../../i18n/translate.ts";
import { readTweaks, tweakValue, TWEAK_SET_MESSAGE, type TweakControl, type TweakGroup, type TweakValue } from "../../../shared/preview.ts";

export interface TweakChange {
	group: string;
	control: TweakControl;
	from: TweakValue;
	to: TweakValue;
}

/**
 * The design controls a page offered (`plume.tweak`), and where the reader has moved them.
 *
 * Held by the card, not by the panel: closing the panel leaves the page as adjusted, and opening it
 * again has to show the same values. The page's own value for a control is taken the first time the
 * control is seen — later reports carry the values this has set, and are not where it started.
 *
 * `run` is the page's load: a rerun is the page from scratch, so everything is forgotten with it.
 */
export function usePreviewTweaks(frame: RefObject<HTMLIFrameElement | null>, run: number) {
	const [groups, setGroups] = useState<TweakGroup[]>([]);
	const [values, setValues] = useState<Record<string, TweakValue>>({});
	const originals = useRef(new Map<string, TweakValue>());

	useEffect(() => {
		originals.current = new Map();
		setGroups([]);
		setValues({});
		function onMessage(event: MessageEvent) {
			if (event.source !== frame.current?.contentWindow) return;
			const offered = readTweaks(event.data);
			if (!offered) return;
			for (const control of offered.flatMap((group) => group.controls)) if (!originals.current.has(control.id)) originals.current.set(control.id, control.value);
			setGroups(offered);
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [frame, run]);

	const controls = groups.flatMap((group) => group.controls.map((control) => ({ group: group.label, control })));
	const original = (control: TweakControl) => originals.current.get(control.id) ?? control.value;
	const current = (control: TweakControl) => values[control.id] ?? original(control);
	const changes: TweakChange[] = controls
		.filter(({ control }) => control.id in values && values[control.id] !== original(control))
		.map(({ group, control }) => ({ group, control, from: original(control), to: values[control.id]! }));

	function post(entries: { id: string; value: TweakValue }[]) {
		if (entries.length) frame.current?.contentWindow?.postMessage({ [TWEAK_SET_MESSAGE]: entries }, "*");
	}

	return {
		groups,
		changes,
		current,
		set(control: TweakControl, next: unknown) {
			const value = tweakValue(control, next);
			if (value === null) return;
			setValues((now) => ({ ...now, [control.id]: value }));
			post([{ id: control.id, value }]);
		},
		/** Back to how the page drew itself. */
		reset() {
			post(changes.map(({ control, from }) => ({ id: control.id, value: from })));
			setValues({});
		},
		/** Held: the page as it was, for as long as the reader holds it; let go, as adjusted. */
		peek(original: boolean) {
			post(changes.map(({ control, from, to }) => ({ id: control.id, value: original ? from : to })));
		},
	};
}

function shown(control: TweakControl, value: TweakValue): string {
	if (control.kind === "slider") return `${value}${control.unit}`;
	if (control.kind === "toggle") return translate(value ? "preview.tweak.on" : "preview.tweak.off");
	if (control.kind === "select") return control.options.find((option) => option.value === value)?.label ?? String(value);
	return String(value);
}

/**
 * The reader's adjustments, twice: as their bubble says them (`text`), and as the model is to read them
 * (`spoken`) — which page, and each control's old and new value in the page's own terms, so it can
 * find the property it bound and write the new value into the page.
 */
export function tweakMessage(title: string, changes: TweakChange[]): { text: string; spoken: string } {
	const text = translate("preview.tweak.said", { changes: changes.map(({ control, from, to }) => `${control.label} ${shown(control, from)} → ${shown(control, to)}`).join(translate("preview.tweak.joiner")) });
	const settings = changes.map(({ group, control, from, to }) => ({ ...(group ? { group } : {}), control: control.label, from, to, ...(control.kind === "slider" && control.unit ? { unit: control.unit } : {}) }));
	return { text, spoken: `${text}\n\nWrite these design settings into the page ${JSON.stringify(title)} and show it again:\n<design-settings>${JSON.stringify(settings)}</design-settings>` };
}
