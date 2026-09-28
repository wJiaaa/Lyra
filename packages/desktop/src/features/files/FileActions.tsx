/**
 * What you can do to the open file, as marks in the pane's header.
 *
 * They were a labelled toolbar across the top of the viewer: 「在 Zed 中打开」, 「自动换行」, and a
 * couple of others that come and go with the kind of file. That row cost a line of the file for
 * controls that are the same four things every time — worth a glance once, and then furniture. As
 * marks beside the pane's own buttons they take no height at all, and the words they lost are on
 * the tip.
 *
 * Which of them exist depends on the file: Markdown is the only kind with two ways to be read, and
 * wrapping means nothing for an image. A control that would do nothing is not drawn disabled —
 * it is not drawn.
 */

import { useI18n } from "../../i18n/index.ts";
import { Code, ExternalLink, Eye, WrapText } from "lucide-react";

import { openLabel, useOpenTarget } from "../../store/open-targets.ts";
import { useOpenFile } from "../../store/openFile.ts";
import { usePaneFile } from "./pane-file.tsx";
import { fileKind } from "./FileViewer.tsx";
import { available, bridge } from "../../services/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

export function FileActions() {
	const { t } = useI18n();
	const path = usePaneFile((s) => s.path);
	const name = usePaneFile((s) => s.name);
	const contents = usePaneFile((s) => s.contents);
	const wrap = useOpenFile((s) => s.wrap);
	const showSource = useOpenFile((s) => s.showSource);
	const openTarget = useOpenTarget();

	if (!path || !contents) return null;

	const kind = fileKind(name ?? path, contents);
	const textual = kind === "markdown" || kind === "json" || kind === "text";

	return (
		<>
			{/* Truncated at the read cap: what is on screen is the head of the file, not all of it. */}
			{contents.truncated && <span className="shrink-0 px-1 text-caption text-ink-faint">{t("fileActions.tooBig")}</span>}

			{kind === "markdown" && (
				<Mark
					tip={showSource ? t("common.preview") : t("fileActions.viewSource")}
					active={showSource}
					onClick={() => useOpenFile.getState().setShowSource(!showSource)}
				>
					{showSource ? <Eye size={12} strokeWidth={1.9} /> : <Code size={12} strokeWidth={1.9} />}
				</Mark>
			)}
			{/* Not for the Markdown preview, which is prose and wraps regardless. */}
			{textual && !(kind === "markdown" && !showSource) && (
				<Mark tip={t("fileActions.wrap")} active={wrap} onClick={() => useOpenFile.getState().setWrap(!wrap)}>
					<WrapText size={12} strokeWidth={1.9} />
				</Mark>
			)}
			{/*
			 * Opens in whatever 「默认文件打开目标」 names.
			 *
			 * That setting existed and was saved, but nothing anywhere read it — the IPC to open a
			 * path in a named app was already there with no caller. This is the one place a file is
			 * on screen with a path in hand, so it is where it belongs.
			 */}
			{available("system", "openIn") && (
				<Mark tip={openLabel(openTarget)} onClick={() => void bridge.system.openIn(openTarget.id, path)}>
					<ExternalLink size={12} strokeWidth={1.9} />
				</Mark>
			)}
		</>
	);
}

/** One mark, sized and coloured like the pane's own header buttons. */
function Mark({
	tip,
	active,
	onClick,
	children,
}: {
	tip: string;
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return <IconButton size="xs" label={tip} active={active} onClick={onClick} icon={children} />;
}
