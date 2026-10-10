/**
 * 「引用」：这个会话里出现过的图片和文件。收哪些见 `references.ts`。
 *
 * 图片排成一排缩略图在上，点了用图片查看器放大；文件按轮次排在下面，点名字和气泡外那一排附件
 * 走同一条路（`openOrPreview`：项目里的、面板读得了的在右侧打开，别的交给系统），右边「第 N 轮」
 * 跳回那一问。各自先放一屏，多出来的收在「还有 N 个」后面。
 */

import { useMemo, useState } from "react";
import { File } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { intact } from "../../lib/transcript.ts";
import { baseName, joinPath } from "../../lib/paths.ts";
import { jumpToMessage } from "../../store/transcript-jump.ts";
import { useDockScope, useScopedMessages, useScopedWorkspace } from "../../app/session-scope.tsx";
import { sessionMediaUrl, SESSION_THUMB_EDGE } from "../../../shared/session-image.ts";
import { previewableInPanel, sentKind, useAttachmentActions } from "../composer/index.ts";
import { openFilePane } from "../dock/index.ts";
import { openViewer } from "../image/index.ts";
import { referencesIn, type ImageReference } from "./references.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

const IMAGES_SHOWN = 8;
const FILES_SHOWN = 8;

/** 生成的图存在 `session-media` 下，按文件名就能取；别处的图按路径取。 */
function sourcesOf(image: ImageReference): { thumb: string; full: string } | null {
	const { block, path } = image;
	if (block?.media) return { thumb: sessionMediaUrl(block.media, SESSION_THUMB_EDGE), full: sessionMediaUrl(block.media) };
	if (block?.data) {
		const url = `data:${block.mimeType};base64,${block.data}`;
		return { thumb: url, full: url };
	}
	if (!path) return null;
	if (/[\\/]session-media[\\/][^\\/]+$/.test(path)) return { thumb: sessionMediaUrl(baseName(path), SESSION_THUMB_EDGE), full: sessionMediaUrl(baseName(path)) };
	const url = bridge.files.mediaUrl(path);
	return { thumb: url, full: url };
}

const isAbsolute = (path: string) => path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);

export function ReferencesSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const scope = useDockScope();
	const messages = useScopedMessages();
	const { workspace, scratchCwd } = useScopedWorkspace();
	const cwd = workspace?.path ?? scratchCwd ?? "";
	const actions = useAttachmentActions();
	const { images, files } = useMemo(() => referencesIn(intact(messages)), [messages]);
	const pictures = useMemo(() => images.flatMap((image) => {
		const sources = sourcesOf(image);
		return sources ? [{ image, ...sources }] : [];
	}), [images]);
	const [allImages, setAllImages] = useState(false);
	const [allFiles, setAllFiles] = useState(false);
	if (!pictures.length && !files.length) return null;

	const shownPictures = allImages || pictures.length <= IMAGES_SHOWN ? pictures : pictures.slice(0, IMAGES_SHOWN - 1);
	const shownFiles = allFiles || files.length <= FILES_SHOWN ? files : files.slice(0, FILES_SHOWN);
	const turnLabel = (turn: number) => t("environment.turn", { n: turn });

	return (
		<Section name="references">
			<SectionLabel>
				{t("environment.references")} <span className="tabular-nums">{pictures.length + files.length}</span>
			</SectionLabel>
			{pictures.length > 0 && (
				<div className="grid grid-cols-4 gap-1.5 px-2 pb-1.5">
					{shownPictures.map(({ image, thumb }, at) => (
						<button
							key={image.key}
							type="button"
							data-ly-environment-image={image.key}
							data-ly-tip={[image.name, turnLabel(image.turn)].filter(Boolean).join(" · ")}
							className="aspect-[4/3] overflow-hidden rounded-md border border-line-soft bg-card transition-opacity hover:opacity-85"
							onClick={(event) =>
								openViewer(
									pictures.map((picture) => ({ src: picture.full, ...(picture.image.name ? { alt: picture.image.name } : {}) })),
									at,
									event.currentTarget.getBoundingClientRect(),
									event.currentTarget,
								)
							}
						>
							<img src={thumb} alt={image.name} loading="lazy" className="h-full w-full object-cover" />
						</button>
					))}
					{shownPictures.length < pictures.length && (
						<button
							type="button"
							className="aspect-[4/3] rounded-md border border-line-soft bg-card text-caption tabular-nums text-ink-faint transition-colors hover:text-ink"
							onClick={() => setAllImages(true)}
						>
							+{pictures.length - shownPictures.length}
						</button>
					)}
				</div>
			)}
			{shownFiles.map((file) => {
				const path = isAbsolute(file.path) || !cwd ? file.path : joinPath(cwd, file.path);
				return (
					<div key={file.key} data-ly-environment-file={file.path} className="flex items-center gap-0.5">
						<button
							type="button"
							className={`${ROW} flex-1`}
							data-ly-tip={path}
							onClick={(event) =>
								actions.openOrPreview(
									{ name: file.name, path, panelReadable: previewableInPanel(sentKind({ name: file.name }), file.name), onOpenFile: (target) => void openFilePane(target, scope ?? undefined) },
									event.currentTarget.getBoundingClientRect(),
								)
							}
						>
							<File size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
							<span className="min-w-0 flex-1 truncate">{file.name}</span>
						</button>
						<button
							type="button"
							data-ly-tip={t("environment.jumpToTurn")}
							className="h-8 shrink-0 rounded-lg px-1.5 text-caption tabular-nums text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
							onClick={() => jumpToMessage(sessionId, file.index)}
						>
							{turnLabel(file.turn)}
						</button>
					</div>
				);
			})}
			{shownFiles.length < files.length && (
				<button type="button" className={`${ROW} text-ink-faint`} onClick={() => setAllFiles(true)}>
					<span className="w-3.5 shrink-0" />
					{t("environment.moreFiles", { n: files.length - shownFiles.length })}
				</button>
			)}
		</Section>
	);
}
