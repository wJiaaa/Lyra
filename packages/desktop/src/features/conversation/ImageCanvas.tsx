import type { ToolResult } from "@plume/core";
import { useState } from "react";
import { useScopedFromToolRuns } from "../../app/session-scope.tsx";
import { translate } from "../../i18n/index.ts";
import { describeActivity } from "../../lib/tool-kinds.ts";
import { openFromEvent } from "../image/index.ts";
import { useContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { GeneratedImageMenu, type GeneratedImageTarget } from "./GeneratedImageMenu.tsx";
import { imageBlockSrc } from "./image-block.ts";

/**
 * 这一段里画出来的图，画在过程块外面——和 `BrowserCards` 同一个理由。
 *
 * 过程默认收成一行，跑着也一样；图要是长在工具行里就跟着收走了，人得点开「生成图片」再点开那一次
 * 调用才看得见，于是模型只好在回复里贴一个「下载原图」的链接来补。图是这次调用的结果本身，
 * 紧跟在这一段后面：跑的时候是一块点阵在流动的底板，按请求的尺寸先把位置占好，画好了在原地
 * 淡入，不再挤一下版面。
 *
 * 没有记录的调用（另一段转录、记录已经丢了）不画：失败和停止也不画，那些写在工具行里。
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
	return <ImageCanvas args={run.args} result={run.result} running={run.status === "running"} summary={describeActivity(run.summary)} />;
}

const HEIGHT = 240;

function ImageCanvas({ args, result, running, summary }: { args: Record<string, unknown>; result?: ToolResult; running: boolean; summary: string }) {
	const images = (result?.content ?? []).flatMap((block) => {
		const refs = block.type === "image" ? imageBlockSrc(block, HEIGHT * 2) : null;
		return refs ? [refs] : [];
	});
	const ratio = requestedRatio(args.size);
	/*
	 * 只有亲眼看着它画的这一次才过渡宽度。
	 *
	 * 占位按请求的比例（没给尺寸就是正方形），图到了才知道真比例；生成时这一下过渡是底板落成图。
	 * 翻历史记录时卡片每次都是新挂上的，同一段过渡就成了「一打开会话图就从大缩到小」。
	 */
	const [live] = useState(running);
	const menu = useContextMenu<GeneratedImageTarget>();

	if (images.length === 0) {
		if (!running) return null;
		return (
			<div
				role="img"
				aria-label={translate("toolCard.generatingImage")}
				data-ly-canvas="pending"
				className="ly-canvas max-w-full rounded-[14px]"
				style={{ width: HEIGHT * ratio, aspectRatio: ratio }}
			/>
		);
	}

	const gallery = images.map((image, index) => ({ src: image.full, alt: translate("toolCard.image", { summary, n: index + 1 }) }));
	// 工具在 details 里记下每张图落盘的位置，顺序和图一致；老记录没有这一项。
	const paths = (result?.details as { paths?: unknown } | undefined)?.paths;
	return (
		<div className="flex flex-wrap gap-2">
			{images.map((image, index) => (
				<Shot
					key={index}
					src={image.src}
					alt={gallery[index]?.alt ?? ""}
					ratio={ratio}
					glide={live}
					onOpen={(event) => openFromEvent(event, gallery, index)}
					onMenu={(event) => {
						const path = Array.isArray(paths) ? paths[index] : undefined;
						menu.show(event, { src: image.full, ...(typeof path === "string" ? { path } : {}) });
					}}
				/>
			))}
			<GeneratedImageMenu anchor={menu.anchor} image={menu.target} onClose={menu.close} />
		</div>
	);
}

function Shot({ src, alt, ratio, glide, onOpen, onMenu }: { src: string; alt: string; ratio: number; glide: boolean; onOpen: (event: React.MouseEvent<HTMLElement>) => void; onMenu: (event: React.MouseEvent<HTMLElement>) => void }) {
	const [loaded, setLoaded] = useState(false);
	// 模型不一定照请求的尺寸出图（没给尺寸时更是它说了算），载入后以图本身的比例为准。
	const [aspect, setAspect] = useState(ratio);
	return (
		<button
			type="button"
			data-ly-canvas={loaded ? "done" : "pending"}
			onClick={onOpen}
			onContextMenu={onMenu}
			className={`ly-canvas relative block max-w-full cursor-zoom-in overflow-hidden rounded-[14px] ${glide ? "transition-[width] duration-[var(--ly-t-slow)]" : ""}`}
			style={{ width: HEIGHT * aspect, aspectRatio: aspect }}
		>
			<img
				alt={alt}
				src={src}
				onLoad={(event) => {
					const { naturalWidth, naturalHeight } = event.currentTarget;
					if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
					setLoaded(true);
				}}
				className={`absolute inset-0 size-full object-cover transition-opacity duration-[var(--ly-t-slow)] ${loaded ? "opacity-100" : "opacity-0"}`}
			/>
		</button>
	);
}

/** `1536x1024` 这样的尺寸取宽高比；`auto` 或没给就按正方形占位。 */
function requestedRatio(size: unknown): number {
	const match = typeof size === "string" ? /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(size) : null;
	const ratio = match ? Number(match[1]) / Number(match[2]) : 1;
	return Number.isFinite(ratio) && ratio > 0 ? Math.min(Math.max(ratio, 0.5), 2) : 1;
}
