import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { OutputTerminal, type OutputSource, type TerminalLook } from "../../ui/terminal/OutputTerminal.tsx";
import { CODE_DEFAULTS, onAppearanceApplied } from "../settings/index.ts";
import { redirectTargets } from "../../lib/redirect-targets.ts";

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
 * A job that ended without printing anything calls `onEmpty`.
 */
function follow(sessionId: string, jobId: string, onEmpty: () => void): OutputSource {
	return (sink) => {
		let live = true;
		let from = -1;
		let whole: string | null = null;
		let wrote = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			try {
				const slice = await bridge.services.output(sessionId, jobId, from);
				if (!live || !slice) return;
				if (slice.text) wrote = true;
				if (slice.replace && slice.next === 0) {
					if (slice.text !== whole) { sink.reset(); sink.write(slice.text); whole = slice.text; }
				} else {
					if (slice.replace) sink.reset();
					if (slice.text) sink.write(slice.text);
					from = slice.next;
				}
				if (slice.done && !wrote) onEmpty();
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
	/*
	 * Said in words instead of an empty terminal: two blank rows on the panel's own background read
	 * as "the output was lost", most of all under a failed job. A command that sent its output into
	 * a file (`go test … > run.log 2>&1`) gets the file named, which is where the reason is.
	 *
	 * Asked once before the terminal mounts: mounting it and then swapping it out flashed two blank
	 * rows that collapsed into one line. A job that ends silent while open is caught by `onEmpty`.
	 */
	const [empty, setEmpty] = useState<boolean | null>(null);
	useEffect(() => {
		let live = true;
		bridge.services.output(sessionId, jobId, -1).then(
			(slice) => { if (live) setEmpty(Boolean(slice?.done && !slice.text)); },
			() => { if (live) setEmpty(false); },
		);
		return () => { live = false; };
	}, [sessionId, jobId]);
	const source = useMemo(() => follow(sessionId, jobId, () => setEmpty(true)), [sessionId, jobId]);
	if (empty === null) return null;
	if (empty) {
		const targets = redirectTargets(command);
		// pl-5 = the terminal's pl-3 plus its own px-2, so the words start where its text would.
		return <p className="mt-1 pl-5 text-caption text-ink-faint break-all" data-job-output-empty="">
			{targets.length > 0 ? t("services.redirected", { path: targets.join(t("services.pathSeparator")) }) : t("services.noOutput")}
		</p>;
	}
	return <div className="mt-1 pl-3"><OutputTerminal source={source} look={LOOK} maxHeight={220} label={t("services.outputLabel", { command })} /></div>;
}
