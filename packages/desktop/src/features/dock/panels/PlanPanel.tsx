/**
 * 右栏的计划面板：把计划摊开读，划一段字就地留评论。
 *
 * 计划交上来时由审批卡替人打开（见 `ApprovalOverlay`）。正文由 `builtin.tsx` 交进来（`renderPlan`），
 * 不在这里 import `Markdown`：那会让这个文件也落进对话域与 dock 之间那个环，`pnpm arch` 的基线只降不升。等审批的时候能评论，评论在人选「要改」时
 * 并进打回理由（`planDecision`），也可以在这里直接按评论打回；批准或打回以后面板只读，那份计划留着看。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useScopedApprovals, useScopedSessionId } from "../../../app/session-scope.tsx";
import { useI18n } from "../../../i18n/index.ts";
import { useApp } from "../../../store/index.ts";
import { ArrowUp, ListOrdered, MessageSquare, X } from "../../../ui/icons/index.ts";
import { Textarea } from "../../../ui/inputs/NativeField.tsx";
import { PanelEmpty } from "../../../ui/layout/PanelEmpty.tsx";
import { Popover } from "../../../ui/overlay/Popover.tsx";
import { Button } from "../../../ui/primitives/Button.tsx";
import { IconButton } from "../../../ui/primitives/IconButton.tsx";
import { Scroller } from "../../../ui/scroll/Scroller.tsx";
import { selectedText } from "../../../lib/selection.ts";
import { planFeedback, usePlanReview } from "../../../store/plan-review.ts";
import { offsetIn, paint, rangeIn } from "./plan-anchor.ts";

interface Draft {
	start: number;
	end: number;
	quote: string;
	/** 评论框挂在选区左下角，滚动时跟着那段字挪。 */
	at: { x: number; y: number };
}

const EMPTY: never[] = [];

function atOf(range: Range): Draft["at"] {
	const rect = range.getBoundingClientRect();
	return { x: rect.left, y: rect.bottom };
}

export function PlanPanel({ renderPlan }: { renderPlan: (text: string) => ReactNode }) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const approvals = useScopedApprovals();
	const review = usePlanReview((state) => (sessionId ? state.reviews[sessionId] : undefined));
	const pending = Boolean(review && approvals.some((request) => request.id === review.requestId));
	const comments = pending ? (review?.comments ?? EMPTY) : EMPTY;
	const bodyRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [owner] = useState(() => Symbol("plan-panel"));
	const [draft, setDraft] = useState<Draft | null>(null);
	const [note, setNote] = useState("");
	const [sending, setSending] = useState(false);

	// 已经评论过的那几段一直标着；换了一份计划或者审批结束，标记跟着评论一起没了。
	useEffect(() => {
		const body = bodyRef.current;
		const ranges = body ? comments.flatMap((comment) => rangeIn(body, comment.start, comment.end) ?? []) : [];
		paint(owner, "ly-plan-comment", ranges);
	}, [owner, comments, review?.text]);

	// 正在写评论的那一段：焦点进了评论框，原生选区就没了，得另外标着人才知道在评哪儿。
	const start = draft?.start;
	const end = draft?.end;
	useEffect(() => {
		const body = bodyRef.current;
		const range = body && start !== undefined && end !== undefined ? rangeIn(body, start, end) : null;
		paint(owner, "ly-plan-draft", range ? [range] : []);
	}, [owner, start, end]);

	useEffect(() => () => {
		paint(owner, "ly-plan-comment", []);
		paint(owner, "ly-plan-draft", []);
	}, [owner]);

	// 审批结束（批准、打回、超时）时手上那条没写完的评论没处可去了，收起来。
	useEffect(() => {
		if (!pending) setDraft(null);
	}, [pending]);

	useEffect(() => {
		const box = scrollRef.current;
		if (!box || start === undefined || end === undefined) return;
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const body = bodyRef.current;
				const range = body ? rangeIn(body, start, end) : null;
				if (range) setDraft((was) => (was ? { ...was, at: atOf(range) } : was));
			});
		};
		box.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			box.removeEventListener("scroll", onScroll);
		};
	}, [start, end]);

	if (!sessionId || !review) return <PanelEmpty icon={ListOrdered} title={t("plan.title")} />;

	const pick = () => {
		const body = bodyRef.current;
		const selection = window.getSelection();
		if (!pending || !body || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
		const picked = selectedText(selection.getRangeAt(0));
		if (!body.contains(picked.startContainer) || !body.contains(picked.endContainer)) return;
		const quote = picked.toString().trim();
		if (!quote) return;
		setNote("");
		setDraft({ start: offsetIn(body, picked.startContainer, picked.startOffset), end: offsetIn(body, picked.endContainer, picked.endOffset), quote, at: atOf(picked) });
	};

	const commit = () => {
		if (!draft || !note.trim()) return;
		usePlanReview.getState().add(sessionId, { quote: draft.quote, start: draft.start, end: draft.end, text: note.trim() });
		window.getSelection()?.removeAllRanges();
		setDraft(null);
	};

	const reveal = (from: number, to: number) => {
		const body = bodyRef.current;
		const node = body ? rangeIn(body, from, to)?.startContainer.parentElement : null;
		node?.scrollIntoView({ block: "center", behavior: "smooth" });
	};

	const revise = async () => {
		if (sending) return;
		setSending(true);
		try {
			await useApp.getState().respondToApproval(review.requestId, { answer: planFeedback(comments) }, sessionId);
		} catch (error) {
			useApp.getState().notify(String(error), "error");
		} finally {
			setSending(false);
		}
	};

	return <>
		<Scroller scrollRef={scrollRef} contentClassName="px-5 py-4">
			{pending && <p className="mb-3 flex items-center gap-1.5 text-caption text-ink-faint" data-plan-hint="">
				<MessageSquare size={13} strokeWidth={1.8} className="shrink-0" />
				{t("plan.commentHint")}
			</p>}
			{/* 松开鼠标时取选区：双击、三击选词选段也是松开之后才定。 */}
			<div ref={bodyRef} onMouseUp={(event) => { if (event.button === 0) requestAnimationFrame(pick); }} data-plan-body="">
				{renderPlan(review.text)}
			</div>
			{comments.length > 0 && <section className="mt-6 border-t border-line pt-4" data-plan-comments="">
				<h3 className="mb-2 text-caption font-medium text-ink-muted">{t("plan.comments", { n: comments.length })}</h3>
				<ul className="flex flex-col gap-1">
					{comments.map((comment) => <li key={comment.id} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-card-hover" data-plan-comment="">
						<button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => reveal(comment.start, comment.end)}>
							<span className="block truncate border-l-2 border-accent/50 pl-2 text-caption text-ink-muted">{comment.quote}</span>
							<span className="mt-1 block whitespace-pre-wrap break-words text-label text-ink">{comment.text}</span>
						</button>
						<IconButton size="sm" icon={<X size={13} />} label={t("plan.deleteComment")} onClick={() => usePlanReview.getState().remove(sessionId, comment.id)} />
					</li>)}
				</ul>
			</section>}
		</Scroller>
		{comments.length > 0 && <div className="flex shrink-0 justify-end border-t border-line px-4 py-2.5">
			<Button variant="primary" size="sm" disabled={sending} onClick={() => void revise()}>{t("plan.reviseWithComments", { n: comments.length })}</Button>
		</div>}
		{draft && <Popover anchor={draft.at} onClose={() => setDraft(null)} placement="bottom" align="start" width={320} surface="panel" role="dialog" label={t("plan.commentPlaceholder")}>
			<form className="flex items-end gap-1.5 p-2" onSubmit={(event) => { event.preventDefault(); commit(); }}>
				<Textarea
					autoFocus
					rows={2}
					value={note}
					placeholder={t("plan.commentPlaceholder")}
					onChange={(event) => setNote(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							commit();
						} else if (event.key === "Escape") {
							event.stopPropagation();
							setDraft(null);
						}
					}}
					className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-label text-ink placeholder:text-ink-faint focus:outline-none"
					data-plan-comment-input=""
				/>
				<IconButton size="sm" icon={<ArrowUp size={14} />} onClick={commit} label={t("plan.commentSubmit")} disabled={!note.trim()} />
			</form>
		</Popover>}
	</>;
}
