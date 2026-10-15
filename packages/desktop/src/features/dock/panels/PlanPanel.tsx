/**
 * 右栏的计划面板：把计划摊开读，划一段字就地留评论。
 *
 * 计划交上来时由审批卡替人打开（见 `ApprovalOverlay`）。正文由 `builtin.tsx` 交进来（`renderPlan`），
 * 不在这里 import `Markdown`：那会让这个文件也落进对话域与 dock 之间那个环，`pnpm arch` 的基线只降不升。等审批的时候能评论：
 * 这里只管划线和写，评论本身列在审批卡上（`PlanApproval`），由那里修订或带着接受；面板上那段字画下划线、
 * 末尾挂一枚和卡上同号的序号。批准或打回以后面板只读，那份计划留着看。
 *
 * 等审批时正文用审批卡上那一份；其余时候从会话历史里读最后交上来的那份（`currentPlan`），重启以后也还在。
 */

import { currentPlan, renderPlan as planMarkdown } from "@plume/core/plan-view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useScopedApprovals, useScopedFromMessages, useScopedSessionId } from "../../../app/session-scope.tsx";
import { useI18n } from "../../../i18n/index.ts";
import { ArrowUp, ListOrdered, MessageSquare } from "../../../ui/icons/index.ts";
import { Textarea } from "../../../ui/inputs/NativeField.tsx";
import { PanelEmpty } from "../../../ui/layout/PanelEmpty.tsx";
import { Popover } from "../../../ui/overlay/Popover.tsx";
import { IconButton } from "../../../ui/primitives/IconButton.tsx";
import { MarkNumber } from "../../../ui/primitives/MarkNumber.tsx";
import { Scroller } from "../../../ui/scroll/Scroller.tsx";
import { selectedText } from "../../../lib/selection.ts";
import { usePlanReview } from "../../../store/plan-review.ts";
import { offsetIn, paint, rangeIn } from "./plan-anchor.ts";

interface Draft {
	start: number;
	end: number;
	quote: string;
	/** 评论框挂在选区左下角，滚动时跟着那段字挪。 */
	at: { x: number; y: number };
}

const EMPTY: never[] = [];

interface Mark {
	id: string;
	n: number;
	x: number;
	y: number;
}

/**
 * 这段字最后一个字的右上角，相对正文左上角：序号像脚注一样挂在那里，圆心落在这一行的上沿。
 * 挂在下划线末端试过：它压在下一个字的下半截上，句读（「，」「。」）整个被盖住。上沿那一截在行距里，
 * 只擦到下一个字的左上角。
 */
function markAt(body: HTMLElement, start: number, end: number): Pick<Mark, "x" | "y"> | null {
	const rects = rangeIn(body, start, end)?.getClientRects();
	const last = rects && [...rects].reverse().find((rect) => rect.width > 0);
	if (!last) return null;
	const origin = body.getBoundingClientRect();
	return { x: Math.round(last.right - origin.left - 2), y: Math.round(last.top - origin.top + 1) };
}

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
	// 两个字符串分开取：选择器每次返回新对象，store 一动就要重画。
	const saved = useScopedFromMessages((messages) => {
		const plan = currentPlan(messages);
		return plan ? planMarkdown(plan.plan) : null;
	});
	const approved = useScopedFromMessages((messages) => currentPlan(messages)?.status === "approved");
	const text = pending && review ? review.text : saved;
	const bodyRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [owner] = useState(() => Symbol("plan-panel"));
	const [draft, setDraft] = useState<Draft | null>(null);
	const [note, setNote] = useState("");

	const [marks, setMarks] = useState<Mark[]>([]);

	// 已经评论过的那几段一直标着；换了一份计划或者审批结束，标记跟着评论一起没了。
	useEffect(() => {
		const body = bodyRef.current;
		const ranges = body ? comments.flatMap((comment) => rangeIn(body, comment.start, comment.end) ?? []) : [];
		paint(owner, "ly-plan-comment", ranges);
		if (!body || comments.length === 0) {
			setMarks([]);
			return;
		}
		// 序号挂在那段字最后一个字的右上角；面板变宽变窄、正文重新折行时跟着挪。
		const place = () => setMarks(comments.flatMap((comment, index) => {
			const at = markAt(body, comment.start, comment.end);
			return at ? [{ id: comment.id, n: index + 1, ...at }] : [];
		}));
		place();
		const watch = new ResizeObserver(place);
		watch.observe(body);
		return () => watch.disconnect();
	}, [owner, comments, text]);

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

	if (!sessionId || text === null) return <PanelEmpty icon={ListOrdered} title={t("plan.title")} />;

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

	return <>
		<Scroller scrollRef={scrollRef} contentClassName="px-5 py-4">
			{pending && <p className="mb-3 flex items-center gap-1.5 text-caption text-ink-faint" data-plan-hint="">
				<MessageSquare size={13} strokeWidth={1.8} className="shrink-0" />
				{t("plan.commentHint")}
			</p>}
			{!pending && <p className="mb-3 text-caption text-ink-faint" data-plan-status="">{t(approved ? "plan.approved" : "plan.declined")}</p>}
			{/* 松开鼠标时取选区：双击、三击选词选段也是松开之后才定。 */}
			<div className="relative">
				<div ref={bodyRef} onMouseUp={(event) => { if (event.button === 0) requestAnimationFrame(pick); }} data-plan-body="">
					{renderPlan(text)}
				</div>
				{/* 每条评论那段字的末尾一枚序号，和审批卡上那条评论前面的数一样。不接鼠标：挡着它就划不了后面的字。 */}
				{marks.map((mark) => <MarkNumber key={mark.id} n={mark.n} className="pointer-events-none absolute -translate-y-1/2 shadow-sm" data-plan-mark={mark.n} style={{ left: mark.x, top: mark.y }} />)}
			</div>
		</Scroller>
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
