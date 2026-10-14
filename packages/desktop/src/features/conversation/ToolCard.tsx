import type { DiffHunk, ImageContent, ToolResult } from "@plume/core";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { ArrowUpRight, Ban, CircleX } from "../../ui/icons/index.ts";
import { Fragment, useEffect, useRef, useState } from "react";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { ToolIcon } from "./tool-icons.tsx";
import { RollWords } from "../../ui/motion/RollWords.tsx";
import { CodeText } from "./detail/CodeText.tsx";
import { Section } from "./detail/Section.tsx";
import { DiffView } from "../git/index.ts";
import { useTranscriptDisclosure } from "./view-state.ts";
import { stoppedByUser } from "./tool-status.ts";
import { translate, useI18n } from "../../i18n/index.ts";
import { openFromEvent } from "../image/index.ts";
import { imageBlockSrc } from "./image-block.ts";


interface ToolCardProps {
	stateKey?: string;
	toolName: string;
	summary: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	result?: ToolResult;
	/**
	 * When the call actually started, from the record rather than from this component's lifetime.
	 *
	 * Timing from mount is only the same thing while the card is mounted for the whole call, and it
	 * is not: scrolling away and back, or any re-key of the list, restarts the count from zero. A
	 * command seven minutes in would say `142s` — under the turn's own elapsed time, in the same
	 * screenshot, which is how it was noticed.
	 */
	startedAt?: number;
	/** 换掉前面那枚工具图标——派出去的子智能体用它自己的脸。 */
	mark?: React.ReactNode;
	/** 摘要后面的一小段附注：派给了谁。 */
	aside?: React.ReactNode;
	/**
	 * 点这一行不是展开，而是去别处看——子智能体的全过程在它自己的面板里，比卡片里那一段参数和
	 * 结果完整得多。给了它，箭头换成「↗」。
	 */
	onOpen?: () => void;
	openLabel?: string;
	/** 还在跑、但还没真正开始：不转圈、不计时，只说一句为什么。 */
	pending?: string;
	/**
	 * 跟在这次调用后面、还在写的那段推理：接在句尾说「正在思考」，句子本身不动。见 `WorkStep`。
	 */
	thinking?: React.ReactNode;
	/** 展开之后、调用详情下面的东西：跟在这次调用后面的推理。 */
	extra?: React.ReactNode;
}

export function ToolCard({ toolName, summary, args, status, result, stateKey, startedAt, mark, aside, onOpen, openLabel, pending, thinking, extra }: ToolCardProps) {
	const { t } = useI18n();
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const [elapsed, setElapsed] = useState(0);
	const details = result?.details as Record<string, unknown> | undefined;
	const hasDiff = Array.isArray(details?.hunks) && (details.hunks as DiffHunk[]).length > 0;
	const running = status === "running";
	// Stopped, not failed: said in neutral words rather than in red. See `stoppedByUser`.
	const stopped = status === "error" && stoppedByUser(result);
	const failed = status === "error" && !stopped;
	const { command: _command, ...rest } = args as Record<string, unknown>;
	const output = result ? resultText(result) : "";
	// 进度里只有 `details`、没有内容的（`image_generate` 开跑时报的形状），对这张卡还什么都不是。
	const shown = running && result?.content.length === 0 ? undefined : result;

	// A visible timer is the honest signal that a long command is still going.
	const mountedAt = useRef(Date.now());
	const since = startedAt ?? mountedAt.current;
	useEffect(() => {
		if (!running) return;
		setElapsed(Math.floor((Date.now() - since) / 1000));
		const timer = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 250);
		return () => clearInterval(timer);
	}, [running, since]);

	const live = running && !pending;
	// ly-pop 说的是「刚刚跑完」。挂载时就已结束的卡片（历史记录、第一次展开的分组）不弹，否则每次展开 +N -M 都跳一下。
	const pop = useRef(running).current ? "ly-pop " : "";
	// What opens under the call.
	const body = hasDiff ? (
		<DiffView hunks={details?.hunks as DiffHunk[]} path={String(details?.path ?? "")} showPath />
	) : (
		<>
			{/*
			 * A command is shown as a command, not as a field in a JSON object.
			 *
			 * What was run is the thing you check first when something looks wrong, and
			 * `{"command": "cd … && npm install …", "timeout": 300000}` makes you read
			 * around the syntax to find it. The rest of the arguments still print as
			 * JSON below, because for every other tool that is the honest shape.
			 */}
			{typeof args.command === "string" && (
				<Section title={t("commands.title")} mono tone="ink">
					<span className="mr-2 select-none text-ink-faint">$</span>
					<CodeText text={args.command} kind="shell" />
				</Section>
			)}
			{Object.keys(rest).length > 0 && (
				<Section title={t("mcp.args")} mono>
					<CodeText text={JSON.stringify(rest, null, 2)} kind="json" />
				</Section>
			)}
			{/*
			 * Silence is a state too.
			 *
			 * A long install prints nothing for minutes while it downloads, and a card
			 * with a command and no output section looks like a card that has lost its
			 * output. Saying so is the difference between waiting and wondering.
			 */}
			{!shown && running && (
				<Section title={t("toolCard.outputRunning")} mono>
					<span className="text-ink-faint">{t("toolCard.waiting")}</span>
				</Section>
			)}
			{shown && (
				<Section
					title={stopped ? t("toolCard.stopped") : failed ? t("common.error") : running ? t("toolCard.outputRunning") : t("common.result")}
					mono={output !== ""}
					tone={failed ? "danger" : "muted"}
				>
					{output !== "" && (
						<Scroller className="max-h-[420px]" overscroll="auto">
							{output}
						</Scroller>
					)}
					<ResultImages result={shown} summary={summary} spaced={output !== ""} />
				</Section>
			)}
		</>
	);

	const notes = [
		thinking ? <Fragment key="thinking">{thinking}</Fragment> : null,
		aside ? <Fragment key="aside">{aside}</Fragment> : null,
		running && pending ? <span key="pending" className="text-caption text-ink-faint">{pending}</span> : null,
		live && elapsed > 0 ? <span key="elapsed" className="tabular-nums text-caption">{elapsed}s</span> : null,
		failed ? <CircleX key="failed" size={13} strokeWidth={1.9} className={`${pop}text-danger/85`} /> : null,
		stopped ? (
			<span key="stopped" data-ly-tip={t("toolCard.stopped")} aria-label={t("toolCard.stopped")} className={`${pop}flex`}>
				<Ban size={13} strokeWidth={1.9} aria-hidden />
			</span>
		) : null,
		hasDiff ? (
			<span key="diff" className={`${pop}font-mono text-caption`}>
				<span className="text-ok">+{String(details?.added ?? 0)}</span> <span className="text-danger">-{String(details?.removed ?? 0)}</span>
			</span>
		) : null,
		onOpen ? <ArrowUpRight key="open" size={12} strokeWidth={2} aria-hidden /> : null,
	].filter(Boolean);

	/*
	 * One call is one line, the same skeleton as the thinking and turn lines around it (`FlowRow`).
	 *
	 * A bordered card per call, inside an open turn, made a stack of boxes between lines of prose.
	 * Running is said the way every other row says it — the glide on the words, plus the seconds —
	 * and done is the quiet state; failure and stopping still carry their marks. The details open in
	 * a framed box under the line.
	 */
	return (
		<div data-ly-avatar-host={mark ? "" : undefined} data-ly-tool={status} className="ly-enter">
			<FlowRow
				icon={mark ?? <ToolIcon name={toolName} />}
				// 参数流进来时字往后长（「修改文件」→「修改文件 one.ts」），宽度缓过去，行尾的箭头不跳。
				// 光挂在字上而不是经 `running` 挂在外层，和一段活的那一行同一种写法。见 `RollWords`。
				summary={<RollWords rollKey="call" text={summary} glide={live}>{summary}</RollWords>}
				trailing={notes.length > 0 ? <span className="flex items-center gap-2">{notes}</span> : undefined}
				open={onOpen ? undefined : open}
				onToggle={() => (onOpen ? onOpen() : setOpen((v) => !v))}
				label={onOpen ? openLabel : undefined}
				data-ly-tip={onOpen ? openLabel : undefined}
			/>

			{!onOpen && (
				<Collapse open={open} bodyClassName="flex flex-col gap-2.5 pt-1.5 pl-[22px]">
					<div className="overflow-hidden rounded-lg border border-line-soft bg-card/45">{body}</div>
					{extra}
				</Collapse>
			)}
		</div>
	);
}

function resultText(result: ToolResult): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.slice(0, 20000);
}

/**
 * A tool that returned a picture shows the picture.
 *
 * `read` on a PNG, a browser screenshot, an MCP image: the model saw pixels, and the card used to
 * say `[图片 image/png]` in their place — the one thing in the call you would open it to look at.
 * Drawn at twice the CSS height so a parked thumbnail stays sharp on a retina screen; a click opens
 * the full picture in the viewer.
 */
const RESULT_THUMB_HEIGHT = 160;

function ResultImages({ result, summary, spaced }: { result: ToolResult; summary: string; spaced: boolean }) {
	/*
	 * 模型手上的和人眼前的可以不是同一份：MCP 工具返回的大图不塞进请求（模型拿到的是一个路径，见
	 * `core/src/mcp/result.ts`），落在 `session-media` 里、记在 `details.images`，这里照样画出来。
	 */
	const parked = (result.details as { images?: unknown } | undefined)?.images;
	const blocks = [...result.content, ...(Array.isArray(parked) ? (parked as ImageContent[]).filter((block) => block?.type === "image") : [])];
	const images = blocks.flatMap((block) => {
		const refs = block.type === "image" ? imageBlockSrc(block, RESULT_THUMB_HEIGHT * 2) : null;
		return refs ? [refs] : [];
	});
	if (images.length === 0) return null;
	const gallery = images.map((image, index) => ({ src: image.full, alt: translate("toolCard.image", { summary, n: index + 1 }) }));
	return (
		<div className={`flex flex-wrap gap-2 ${spaced ? "mt-2" : ""}`}>
			{images.map((image, index) => (
				<button key={index} type="button" className="block cursor-zoom-in" onClick={(event) => openFromEvent(event, gallery, index)}>
					<img
						alt={gallery[index]?.alt}
						src={image.src}
						style={{ maxHeight: RESULT_THUMB_HEIGHT }}
						className="max-w-full rounded-lg border border-line-soft object-contain"
					/>
				</button>
			))}
		</div>
	);
}
