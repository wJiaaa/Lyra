import { translate } from "../../i18n/translate.ts";
import { FileWarning } from "lucide-react";
import type { FileContents } from "../../../electron/ipc-types.ts";
import { CodeEditor } from "../editor/index.ts";
import { documentKind } from "../../../shared/document-kind.ts";
import { PdfView, WordView } from "./DocumentView.tsx";
import { ImagePane } from "./ImagePane.tsx";
import { SheetView } from "./SheetView.tsx";
import { Markdown } from "../conversation/index.ts";
import { directoryOf } from "../../lib/markdown/assets.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useOpenFile } from "../../store/openFile.ts";
import { available, bridge } from "../../services/index.ts";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);

function extensionOf(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot > 0 ? lower.slice(dot + 1) : "";
}

export type FileKind =
	| "image"
	| "video"
	| "audio"
	| "markdown"
	| "json"
	| "text"
	| "binary"
	/** A spreadsheet or a SQLite database — both drawn as a grid; see `SheetView`. */
	| "sheet"
	| "pdf"
	| "document";

/**
 * What kind of thing this file is, for anything deciding how to treat it.
 *
 * Exported because the pane's header asks the same question — which kinds get 「自动换行」 — and
 * two answers to it would drift.
 */
export function fileKind(name: string, contents: FileContents | null): FileKind {
	const ext = extensionOf(name);
	if (IMAGE.has(ext)) return "image";
	if (VIDEO.has(ext)) return "video";
	if (AUDIO.has(ext)) return "audio";
	/*
	 * Documents, before the NUL-byte check that would otherwise call all of them binary.
	 *
	 * `documentKind` is shared with the main process — see `shared/document-kind.ts` — because
	 * the two have to agree about what a `.xlsx` is. The window decides which pane to draw and the
	 * main process decides which reader to run; disagreement there is a file that opens as
	 * mojibake in a pane that was expecting rows.
	 */
	const document = documentKind(name);
	if (document === "workbook" || document === "database") return "sheet";
	if (document === "pdf") return "pdf";
	if (document === "document") return "document";
	// A media extension wins over the NUL-byte check: a PNG is "binary" and still viewable.
	if (contents?.binary) return "binary";
	if (ext === "md" || ext === "mdx") return "markdown";
	if (ext === "json" || ext === "jsonc") return "json";
	return "text";
}

/**
 * One file, shown the way that file wants to be shown.
 *
 * A single "file contents" pane that renders everything as text is wrong for most of what is
 * actually in a project: an image becomes a wall of mojibake, a video becomes nothing at all,
 * and Markdown becomes the one thing it is least useful as. Each kind gets the treatment that
 * makes it legible, and the text kinds all get a highlighted, searchable preview rather than a dump.
 */
export function FileViewer({
	path,
	name,
	contents,
}: {
	path: string;
	name: string;
	contents: FileContents;
}) {
	const kind = fileKind(name, contents);
	/*
	 * How to read, not what is being read — so it lives in the store, where the header's controls
	 * can reach it. This component used to own both of these and draw its own toolbar for them;
	 * that row cost a line of the file on every file, for four things that are the same every time.
	 */
	const wrap = useOpenFile((s) => s.wrap);
	const showSource = useOpenFile((s) => s.showSource);

	const text = contents.text;
	const richPreview = available("files", "bytes");

	const media = bridge.files.mediaUrl(path);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{!richPreview && ["image", "video", "audio", "sheet", "pdf", "document"].includes(kind) ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<FileWarning size={26} strokeWidth={1.4} className="text-ink-faint" />
					<p className="text-label text-ink-muted">{translate("fileViewer.webNoPreview")}</p>
					<p className="text-detail text-ink-faint">{translate("fileViewer.webTextOnly")}</p>
				</div>
			) : kind === "image" ? (
				// Zoom and pan, because an icon and a screenshot are both images and neither is
				// legible at "whatever fits the pane" — see `ImagePane`.
				<ImagePane key={path} src={media} name={name} />
			) : kind === "sheet" ? (
				<SheetView key={path} path={path} />
			) : kind === "pdf" ? (
				<PdfView key={path} path={path} name={name} />
			) : kind === "document" ? (
				<WordView key={path} path={path} />
			) : kind === "video" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center bg-black/85 p-2">
					{/* useMediaCaption 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: a file preview has no caption track. */}
					<video src={media} controls className="max-h-full max-w-full rounded-md" />
				</div>
			) : kind === "audio" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center p-4">
					{/* useMediaCaption 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: a file preview has no caption track. */}
					<audio src={media} controls className="w-full max-w-[420px]" />
				</div>
			) : kind === "binary" ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<FileWarning size={26} strokeWidth={1.4} className="text-ink-faint" />
					<p className="text-label text-ink-muted">{translate("fileViewer.binary")}</p>
					<p className="text-detail text-ink-faint">{formatBytes(contents.bytes)}</p>
				</div>
			) : kind === "markdown" && !showSource ? (
				<Scroller className="flex-1" contentClassName="px-3">
					<div className="py-3">
						{/*
						 * The two things a rendered document needs beyond its own text.
						 *
						 * `baseDir` is what `<img src="assets/logo.png">` is relative to — this file's own
						 * folder — and `remoteImages` says its https references may be fetched. Given here
						 * and nowhere else: this is a file the user opened off their own disk, which is a
						 * different thing from a comment that arrived over the network. See `Markdown`.
						 */}
						<Markdown text={text} baseDir={directoryOf(path)} remoteImages />
					</div>
				</Scroller>
			) : (
				<CodeEditor path={path} text={text} wrap={wrap} />
			)}
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
