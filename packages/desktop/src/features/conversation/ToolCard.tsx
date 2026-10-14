import type { DiffHunk, ImageContent, ToolResult } from "@plume/core";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import {
	Archive,
	ArrowUpRight,
	Ban,
	Cable,
	ChevronRight,
	CircleCheck,
	CircleX,
	FileCode,
	FilePlus,
	FileText,
	FolderTree,
	Globe,
	Image,
	ListTodo,
	Search,
	Sparkles,
	SquarePen,
	Terminal,
	Users,
} from "../../ui/icons/index.ts";
import { Fragment, useEffect, useRef, useState } from "react";
import { StatusSpinner } from "../../ui/motion/loaders.tsx";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { useCallChain } from "./call-chain.ts";
import { CodeText } from "./detail/CodeText.tsx";
import { Section } from "./detail/Section.tsx";
import { DiffView } from "../git/index.ts";
import type { McpMark } from "./mcp-marks.ts";
import { safeColour } from "../settings/index.ts";
import { useMcpMark } from "./useMcpMark.ts";
import { useTranscriptDisclosure } from "./view-state.ts";
import { stoppedByUser } from "./tool-status.ts";
import { translate, useI18n } from "../../i18n/index.ts";
import { openFromEvent } from "../image/index.ts";
import { imageBlockSrc } from "./image-block.ts";

const ICONS: Record<string, typeof FileText> = {
	read: FileText,
	write: FilePlus,
	edit: FileCode,
	ls: FolderTree,
	glob: Search,
	grep: Search,
	bash: Terminal,
	bash_output: Terminal,
	todo_write: ListTodo,
	task: Users,
	skill: Sparkles,
	web_fetch: Globe,
	image_generate: Image,
	mcp_search: Search,
	// The sidebar's own marks for a new chat and for archiving, so the row and the place it acts on agree.
	spawn_session: SquarePen,
	archive_session: Archive,
};

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
}

export function ToolCard({ toolName, summary, args, status, result, stateKey, startedAt, mark, aside, onOpen, openLabel, pending }: ToolCardProps) {
	const { t } = useI18n();
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const [elapsed, setElapsed] = useState(0);
	const mcpMark = useMcpMark()(toolName);
	/*
	 * `Cable` rather than `Globe` for a server with no icon of its own.
	 *
	 * The globe was already `web_fetch`'s, so an MCP call and a page fetch drew the same thing —
	 * and a globe says "the network", which is true of a hosted server and false of the stdio ones
	 * that are most of this catalogue. `Cable` is what 设置 › MCP and the plugins page already use
	 * for this, so a row now agrees with the pages the server is managed on.
	 */
	const Icon = ICONS[toolName] ?? (mcpMark ? Cable : Terminal);
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
	const chain = useCallChain();

	// What opens under the call, in either layout.
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

	if (chain === "expanded") {
		// The earlier layout (设置 › 外观 › 调用链 › 展开): a bordered card with a spinner and a tick.
		return (
			<div
				data-ly-avatar-host={mark ? "" : undefined}
				data-ly-tool={status}
				className={`ly-enter overflow-hidden rounded-[10px] border transition-colors duration-[var(--ly-t-base)] ${
					live ? "ly-rail border-info/30 bg-card/60" : "border-line-soft bg-card/45"
				}`}
			>
				<button
					type="button"
					aria-expanded={onOpen ? undefined : open}
					aria-label={onOpen ? openLabel : undefined}
					data-ly-tip={onOpen ? openLabel : undefined}
					onClick={() => (onOpen ? onOpen() : setOpen((v) => !v))}
					className="ly-scroll flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover/50"
				>
					{mark ?? <ToolMark mark={mcpMark} Icon={Icon} running={running} size={14} />}
					<span className={`min-w-0 flex-1 truncate text-label transition-colors duration-[var(--ly-t-base)] ${live ? "text-ink" : "text-ink-faint"}`}>
						{summary}
					</span>
					{aside}

					{running && pending && <span className="shrink-0 text-caption text-ink-faint">{pending}</span>}
					{live && (
						<span className="flex shrink-0 items-center gap-1.5 text-caption text-info/80">
							{elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
							<StatusSpinner size={12} />
						</span>
					)}
					{status === "done" && <CircleCheck size={13} strokeWidth={1.9} className="ly-pop shrink-0 text-ok/75" />}
					{failed && <CircleX size={13} strokeWidth={1.9} className="ly-pop shrink-0 text-danger/85" />}
					{stopped && (
						<span data-ly-tip={t("toolCard.stopped")} aria-label={t("toolCard.stopped")} className="ly-pop flex shrink-0 text-ink-faint">
							<Ban size={13} strokeWidth={1.9} aria-hidden />
						</span>
					)}

					{hasDiff && (
						<span className="ly-pop shrink-0 font-mono text-caption">
							<span className="text-ok">+{String(details?.added ?? 0)}</span>{" "}
							<span className="text-danger">-{String(details?.removed ?? 0)}</span>
						</span>
					)}

					{onOpen ? (
						<ArrowUpRight size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
					) : (
						<ChevronRight
							size={13}
							strokeWidth={2}
							className="shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-base)]"
							style={open ? { transform: "rotate(90deg)" } : undefined}
						/>
					)}
				</button>

				{open && !onOpen && <div className="ly-enter border-t border-line-soft">{body}</div>}
			</div>
		);
	}

	const notes = [
		aside ? <Fragment key="aside">{aside}</Fragment> : null,
		running && pending ? <span key="pending" className="text-caption text-ink-faint">{pending}</span> : null,
		live && elapsed > 0 ? <span key="elapsed" className="tabular-nums text-caption">{elapsed}s</span> : null,
		failed ? <CircleX key="failed" size={13} strokeWidth={1.9} className="ly-pop text-danger/85" /> : null,
		stopped ? (
			<span key="stopped" data-ly-tip={t("toolCard.stopped")} aria-label={t("toolCard.stopped")} className="ly-pop flex">
				<Ban size={13} strokeWidth={1.9} aria-hidden />
			</span>
		) : null,
		hasDiff ? (
			<span key="diff" className="ly-pop font-mono text-caption">
				<span className="text-ok">+{String(details?.added ?? 0)}</span> <span className="text-danger">-{String(details?.removed ?? 0)}</span>
			</span>
		) : null,
		onOpen ? <ArrowUpRight key="open" size={12} strokeWidth={2} aria-hidden /> : null,
	].filter(Boolean);

	/*
	 * One call is one line, the same skeleton as the thinking and turn lines around it (`FlowRow`).
	 *
	 * The bordered card above, inside an open turn, made a stack of boxes between lines of prose.
	 * Running is said the way every other row says it — the glide on the words, plus the seconds —
	 * and done is the quiet state; failure and stopping still carry their marks. The details open in
	 * a framed box under the line.
	 */
	return (
		<div data-ly-avatar-host={mark ? "" : undefined} data-ly-tool={status} className="ly-enter">
			<FlowRow
				icon={mark ?? <ToolMark mark={mcpMark} Icon={Icon} />}
				summary={summary}
				running={live}
				trailing={notes.length > 0 ? <span className="flex items-center gap-2">{notes}</span> : undefined}
				open={onOpen ? undefined : open}
				onToggle={() => (onOpen ? onOpen() : setOpen((v) => !v))}
				label={onOpen ? openLabel : undefined}
				data-ly-tip={onOpen ? openLabel : undefined}
			/>

			{!onOpen && (
				<Collapse open={open} bodyClassName="pt-1.5 pl-[22px]">
					<div className="overflow-hidden rounded-[10px] border border-line-soft bg-card/45">{body}</div>
				</Collapse>
			)}
		</div>
	);
}

/**
 * The mark at the start of a tool row.
 *
 * A glyph for everything built in, and for an MCP call the picture of the server that answered it —
 * because "which server was that" is the question a row of MCP calls has to answer, and the name is
 * already competing with the tool's own name for the same line of text.
 *
 * Drawn at the glyph's size and given no background. A row is 14px of ink beside a sentence; the
 * tile treatment the catalogue uses would make the busiest thing in a transcript the logo of
 * whatever the model happened to call.
 */
function ToolMark({ mark, Icon, running, size = 13 }: { mark: McpMark | null; Icon: typeof FileText; running?: boolean; size?: number }) {
	const tint = safeColour(mark?.brandColor);
	// Only the bordered card passes `running`: it pulses the mark. A row says running with its glide.
	const card = running !== undefined;

	if (mark?.logo) {
		return (
			<img
				src={mark.logo}
				alt=""
				width={size}
				height={size}
				className={`shrink-0 rounded-[3px] object-cover transition-opacity duration-[var(--ly-t-base)] ${running ? "ly-pulse" : "opacity-90"}`}
			/>
		);
	}

	return (
		<Icon
			size={size}
			strokeWidth={1.8}
			aria-label={mark ? translate("toolCard.mcpServer", { name: mark.name }) : undefined}
			// A server that declared a colour and shipped no picture is still told apart from the next
			// one. Only while idle: the running state is the app speaking, and it owns that colour.
			style={tint && !running ? { color: tint } : undefined}
			className={card ? `shrink-0 transition-colors duration-[var(--ly-t-base)] ${running ? "ly-pulse text-info" : "text-ink-faint"}` : "shrink-0"}
		/>
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
