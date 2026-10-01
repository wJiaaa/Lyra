import { useMemo } from "react";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { OutputTerminal, type OutputSource, type TerminalLook } from "../../ui/terminal/OutputTerminal.tsx";
import { CODE_DEFAULTS, onAppearanceApplied } from "../settings/index.ts";

/** The shell's look: the same settings and the same moment of change as `TerminalPane`. */
const LOOK: TerminalLook = {
	appearance: () => useApp.getState().settings?.appearance,
	defaults: CODE_DEFAULTS,
	onApplied: onAppearanceApplied,
};

/** How often a running job's log is read again. Fast enough to watch a server boot. */
const POLL_MS = 500;
/** A read this long means the log is ahead of the view: read again at once rather than wait. */
const CATCHING_UP = 128 * 1024;

/**
 * Follow a job's log file from where the last read ended.
 *
 * The first read starts near the end (see `readSessionServiceOutput`); after that each one only
 * asks for what is new. A job that kept no log file answers with its whole in-memory copy every
 * time, so that is redrawn only when it changed — otherwise the view would flash twice a second.
 */
function follow(sessionId: string, jobId: string): OutputSource {
	return (sink) => {
		let live = true;
		let from = -1;
		let whole: string | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			try {
				const slice = await bridge.services.output(sessionId, jobId, from);
				if (!live || !slice) return;
				if (slice.replace && slice.next === 0) {
					if (slice.text !== whole) { sink.reset(); sink.write(slice.text); whole = slice.text; }
				} else {
					if (slice.replace) sink.reset();
					if (slice.text) sink.write(slice.text);
					from = slice.next;
				}
				if (!slice.done) timer = setTimeout(() => void read(), slice.text.length >= CATCHING_UP ? 0 : POLL_MS);
			} catch {
				if (live) timer = setTimeout(() => void read(), POLL_MS * 4);
			}
		};
		void read();
		return () => { live = false; clearTimeout(timer); };
	};
}

export function JobOutput({ sessionId, jobId, command }: { sessionId: string; jobId: string; command: string }) {
	const { t } = useI18n();
	const source = useMemo(() => follow(sessionId, jobId), [sessionId, jobId]);
	return <div className="mt-1 pl-3"><OutputTerminal source={source} look={LOOK} maxHeight={220} label={t("services.outputLabel", { command })} /></div>;
}
