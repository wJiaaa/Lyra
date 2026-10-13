import type { ImageGenerateDetails, ToolResult } from "@plume/core";
import { useEffect, useState } from "react";
import { useScopedFromToolRuns, useScopedSessionId } from "../../app/session-scope.tsx";
import { translate } from "../../i18n/index.ts";
import { expectedMs, progressAt, stageAt } from "../../lib/image-progress.ts";
import { describeActivity } from "../../lib/tool-kinds.ts";
import { Download, Image as ImageIcon, PencilLine } from "../../ui/icons/index.ts";
import { RollingText } from "../../ui/motion/RollingText.tsx";
import { attachToComposer, openViewer, saveImage } from "../image/index.ts";
import { useContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { GeneratedImageMenu, type GeneratedImageTarget } from "./GeneratedImageMenu.tsx";
import { imageBlockSrc } from "./image-block.ts";

/**
 * 这一段里画出来的图，画在过程块外面——和 `BrowserCards` 同一个理由。
 *
 * 过程默认收成一行，跑着也一样；图要是长在工具行里就跟着收走了，人得点开「生成图片」再点开那一次
 * 调用才看得见，于是模型只好在回复里贴一个「下载原图」的链接来补。图是这次调用的结果本身，
 * 紧跟在这一段后面：跑的时候是点阵在流动的底板，要几张占几块，按要的比例先把位置占好——没说比例的
 * 改图按原图的比例（工具开跑时报上来的 `shapeHint`）——画好了在原地从模糊变清晰，不再挤一下版面。
 *
 * 图上面一行：画的时候说进行到哪一步（估计，见 `lib/image-progress.ts`），重试时说在重试；画完是
 * 模型和尺寸，少了几张也说。跑着和画完都是这一行，换过去下面不动。
 *
 * 没有记录的调用（另一段转录、记录已经丢了）不画，停止也不画。失败只有工具记下了原因时才画成一张
 * 卡片——额度用完、密钥没开这个模型，是人要去做点什么的事，埋在工具行里没人看得见。
 */
export function GeneratedImages({ calls }: { calls: string[] }) {
	return (
		<div className="flex flex-col gap-2.5">
			{calls.map((id) => (
				<GeneratedImage key={id} callId={id} />
			))}
		</div>
	);
}

function GeneratedImage({ callId }: { callId: string }) {
	const run = useScopedFromToolRuns((toolRuns) => toolRuns[callId]);
	if (!run) return null;
	return <ImageCanvas callId={callId} args={run.args} result={run.result} running={run.status === "running"} startedAt={run.startedAt} summary={describeActivity(run.summary)} />;
}

const HEIGHT = 240;

/** 只在画的时候走的钟：百分比是读数，不是节拍。 */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 400);
		return () => window.clearInterval(timer);
	}, [active]);
	return active ? now : Date.now();
}

function ImageCanvas({ callId, args, result, running, startedAt, summary }: { callId: string; args: Record<string, unknown>; result?: ToolResult; running: boolean; startedAt: number; summary: string }) {
	const images = (result?.content ?? []).flatMap((block) => {
		const refs = block.type === "image" ? imageBlockSrc(block, HEIGHT * 2) : null;
		return refs ? [refs] : [];
	});
	const details = result?.details as Partial<ImageGenerateDetails> | undefined;
	const ratio = ratioOf(args.aspect_ratio) ?? (details?.shapeHint && details.shapeHint > 0 ? details.shapeHint : 1);
	/*
	 * 只有亲眼看着它画的这一次才过渡宽度、播落地。
	 *
	 * 占位按要的比例，图到了才知道真比例；生成时这一下过渡是底板落成图。翻历史记录时尺寸直接取
	 * 记下的宽高，不过渡——同一段过渡在那里就成了「一打开会话图就从大缩到小」。
	 */
	const [live] = useState(running);
	const menu = useContextMenu<GeneratedImageTarget>();
	const sessionId = useScopedSessionId();
	const now = useNow(running);
	const count = Math.max(1, Math.min(4, Math.round(Number(details?.count ?? args.count) || 1)));

	if (images.length === 0) {
		if (!running) return details?.error && result?.isError ? <DrawFailed error={details.error} model={details.modelName ?? ""} /> : null;
		const progress = progressAt(now - (details?.startedAt ?? startedAt), expectedMs(details?.model ?? "", details?.quality, count, details?.edit ?? false));
		return (
			<figure data-ly-image-card="drawing" className="m-0 flex flex-col gap-2">
				<Caption text={details?.retry ? translate("imageGen.retrying") : translate(stageAt(progress))} />
				<div className="flex flex-wrap gap-2">
					{Array.from({ length: count }, (_, index) => (
						<div
							key={index}
							role="img"
							aria-label={translate("toolCard.generatingImage")}
							data-ly-canvas="pending"
							className="ly-canvas max-w-full rounded-[14px]"
							style={{ width: HEIGHT * ratio, aspectRatio: ratio }}
						>
							{/*
							 * 一张卡一个读数，在最后一块的角上。底用 `bg-float`：`bg-elevated` 是半透明的一层，压在密的
							 * 那片点上读不出字；`z-[1]` 是因为亮的那层点阵是 `::after`，画在子元素上面。
							 */}
							{index === count - 1 && (
								<span data-ly-image-progress className="pointer-events-none absolute right-2.5 bottom-2.5 z-[1] rounded-full bg-float px-2.5 py-0.5 text-caption font-medium text-ink tabular-nums shadow-[0_2px_10px_rgba(0,0,0,0.12)]">
									{Math.round(progress * 100)}%
								</span>
							)}
						</div>
					))}
				</div>
			</figure>
		);
	}

	// 标注完按「完成」，带标注的副本进这一屏对话的输入框，不是焦点所在的那一屏；记下是从哪张图标的，画廊的链路靠它接上。
	const gallery = images.map((image, index) => ({ src: image.full, alt: translate("toolCard.image", { summary, n: index + 1 }), onAttach: attachToComposer(sessionId, details?.images?.[index]?.media) }));
	// 工具在 details 里记下每张图落盘的位置，顺序和图一致；老记录没有这一项。
	const paths = details?.paths;
	const first = details?.images?.[0];
	const missing = details?.count ? details.count - images.length : 0;
	const caption = [
		details?.modelName,
		images.length === 1 && first?.width && first.height ? `${first.width}×${first.height}` : undefined,
		missing > 0 ? translate("imageGen.partial", { n: missing }) : undefined,
	].filter(Boolean).join(" · ");
	return (
		// `data-ly-image-call` 是画廊请对话滚过去的目标（`reveal.ts`）。
		<figure data-ly-image-card="done" data-ly-image-call={callId} className="m-0 flex flex-col gap-2">
			{caption && <Caption text={caption} />}
			<div className="flex flex-wrap gap-2">
				{images.map((image, index) => (
					<Shot
						key={index}
						src={image.src}
						alt={gallery[index]?.alt ?? ""}
						ratio={sizeOf(details?.images?.[index]) ?? ratio}
						glide={live}
						onOpen={(frame) => openViewer(gallery, index, frame.getBoundingClientRect(), frame)}
						onEdit={(frame) => openViewer([gallery[index]!], 0, frame.getBoundingClientRect(), frame, true)}
						onDownload={() => void saveImage(image.full)}
						onMenu={(event) => {
							const path = Array.isArray(paths) ? paths[index] : undefined;
							menu.show(event, { src: image.full, ...(typeof path === "string" ? { path } : {}) });
						}}
					/>
				))}
			</div>
			<GeneratedImageMenu anchor={menu.anchor} image={menu.target} onClose={menu.close} />
		</figure>
	);
}

function Caption({ text }: { text: string }) {
	return (
		<figcaption className="truncate text-detail text-ink-muted">
			<RollingText>{text}</RollingText>
		</figcaption>
	);
}

/**
 * 一张图的位置：外层是框（圆角、点阵、悬停按钮），里面一颗按钮负责打开。
 *
 * 查看器从框起飞而不是从里面那颗按钮：框才有圆角，按钮读出来是 0，图会从直角飞出去；悬停按钮也
 * 跟着框一起在图飞出去时藏起来。
 */
function Shot({
	src,
	alt,
	ratio,
	glide,
	onOpen,
	onEdit,
	onDownload,
	onMenu,
}: {
	src: string;
	alt: string;
	ratio: number;
	glide: boolean;
	onOpen: (frame: HTMLElement) => void;
	onEdit: (frame: HTMLElement) => void;
	onDownload: () => void;
	onMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) {
	const [loaded, setLoaded] = useState(false);
	// 模型不一定照请求的尺寸出图（没给尺寸时更是它说了算），载入后以图本身的比例为准。
	const [aspect, setAspect] = useState(ratio);
	const frameOf = (event: React.MouseEvent<HTMLElement>) => event.currentTarget.closest<HTMLElement>("[data-ly-canvas]")!;
	return (
		<div
			data-ly-canvas={loaded ? "done" : "pending"}
			onContextMenu={onMenu}
			className={`group/shot ly-canvas relative max-w-full overflow-hidden rounded-[14px] ${glide ? "transition-[width] duration-[var(--ly-t-slow)]" : ""}`}
			style={{ width: HEIGHT * aspect, aspectRatio: aspect }}
		>
			<button type="button" aria-label={alt} onClick={(event) => onOpen(frameOf(event))} className="absolute inset-0 block cursor-zoom-in">
				<img
					alt={alt}
					src={src}
					draggable={false}
					onLoad={(event) => {
						const { naturalWidth, naturalHeight } = event.currentTarget;
						if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
						setLoaded(true);
					}}
					// 看着它画的这一次从模糊变清晰；翻出来的老图直接淡入。
					className={`absolute inset-0 size-full object-cover ${loaded ? (glide ? "ly-image-reveal" : "opacity-100 transition-opacity duration-[var(--ly-t-slow)]") : "opacity-0"}`}
				/>
			</button>
			{loaded && (
				<div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-end justify-between opacity-0 transition-opacity duration-200 group-focus-within/shot:opacity-100 group-hover/shot:opacity-100">
					<button type="button" onClick={(event) => onEdit(frameOf(event))} className="ly-image-action pointer-events-auto gap-1.5 px-3 text-detail font-medium" aria-label={translate("imageGen.edit")}>
						<PencilLine size={14} strokeWidth={2} />
						<span>{translate("imageGen.edit")}</span>
					</button>
					<button type="button" onClick={onDownload} className="ly-image-action pointer-events-auto w-8 justify-center" aria-label={translate("imageGen.download")} data-ly-tip={translate("imageGen.download")}>
						<Download size={15} strokeWidth={2} />
					</button>
				</div>
			)}
		</div>
	);
}

/** `45s`、`12m`、`1h 53m`——和回合计时同一种写法，哪种语言读起来都一样。 */
function span(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function DrawFailed({ error, model }: { error: NonNullable<ImageGenerateDetails["error"]>; model: string }) {
	let title = translate("imageGen.failed");
	let note = error.summary;
	if (error.hint === "check-billing") {
		title = translate("imageGen.quotaSpent", { model });
		note = error.retryAfterMs ? translate("imageGen.resetsIn", { time: span(error.retryAfterMs) }) : "";
	} else if (error.hint === "check-key") {
		title = translate("imageGen.notAllowed", { model });
		note = translate("imageGen.notAllowedHint");
	} else if (error.hint === "blocked") {
		title = translate("imageGen.refused");
		note = translate("imageGen.refusedHint");
	}
	return (
		<div data-ly-image-card="error" className="flex w-fit max-w-[420px] items-start gap-2.5 rounded-xl border border-line bg-card/30 px-3 py-2.5 text-label">
			<ImageIcon size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-faint" />
			<div className="min-w-0">
				<p className="text-ink">{title}</p>
				{note && <p className="mt-0.5 text-caption text-ink-faint" data-ly-tip={error.detail?.slice(0, 400)}>{note}</p>}
			</div>
		</div>
	);
}

/** `"16:9"` 取宽高比；`auto`、没给或读不懂的是 null。 */
function ratioOf(value: unknown): number | null {
	const match = typeof value === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim()) : null;
	return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

/** 工具从文件头读到的宽高：图还没载入，位置就已经是它的样子。 */
function sizeOf(image: { width?: number; height?: number } | undefined): number | undefined {
	return image?.width && image.height ? image.width / image.height : undefined;
}
