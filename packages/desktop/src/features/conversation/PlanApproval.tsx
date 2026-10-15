/**
 * 计划模式交上来的计划，等人拍板的那张卡：一行标题、一排动作。
 *
 * 计划本身在右栏的计划面板里读、划线评论（见 `dock/panels/PlanPanel.tsx`），这里不再画一遍正文，也不走
 * 业务提问那套选项列表——四个动作各是一个按钮，键盘直达：Esc 修改，⌘↵ 主按钮，⇧⌘↵ 接受。窄窗口的右栏
 * 一次只摆一格，开面板会盖住这张卡，所以那时正文仍画在卡里。
 *
 * 回答还是 core `submit_plan` 认的那几种：接受是第一个选项（`PLAN_APPROVE`），修改是带内容的自由回答，
 * 拒绝是 `reject`——core 据此停下这一轮、计划模式留着，等人说下一步。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { useApp, type AppState } from "../../store/index.ts";
import { planFeedback, usePlanReview } from "../../store/plan-review.ts";
import { Textarea } from "../../ui/inputs/NativeField.tsx";
import { macKeyboard, shortcutLabel } from "../../ui/keyboard.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";

/*
 * 一个键一枚键帽，照参考的样子：「⇧ ⌘ ↩」挤在一个框里读不出是三个键。边框取字色的三成，主按钮反色底上
 * 也看得见。非 Mac 键盘写成一串「Ctrl+Shift+Enter」，那是一个词，放一枚。
 */
const CAP = "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-[color-mix(in_srgb,currentColor_30%,transparent)] px-1 font-sans text-[11px] leading-none";

const EMPTY: never[] = [];

function Keys({ keys }: { keys: string[] }) {
	// `\uFE0E` 要文字字形：不加的话 macOS 把 ↩ 画成一枚蓝底 emoji。
	const caps = macKeyboard() ? keys.map((key) => `${key}\uFE0E`) : [shortcutLabel(keys.join(""))];
	return <span className="ml-0.5 flex items-center gap-[3px] opacity-70" aria-hidden>{caps.map((key) => <kbd key={key} className={CAP}>{key}</kbd>)}</span>;
}

export function PlanApproval({ request, sessionId, compact, renderPlan, openPlan, tags }: {
	request: AppState["approvals"][number];
	sessionId: string | null;
	compact: boolean;
	renderPlan: (text: string) => ReactNode;
	openPlan: () => void;
	/** 剩多少时间失效，由 `ApprovalOverlay` 画好交进来。 */
	tags?: ReactNode;
}) {
	const { t } = useI18n();
	const respond = useApp((s) => s.respondToApproval);
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const comments = usePlanReview((s) => (sessionId && s.reviews[sessionId]?.requestId === request.id ? s.reviews[sessionId].comments : EMPTY));
	const [revising, setRevising] = useState(false);
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);
	const busy = useRef(false);
	const first = request.options?.[0];
	const approve = typeof first === "string" ? first : (first?.label ?? "");
	/*
	 * 「接受并开启自动模式」只在逐项询问档时给：已经是自动或完全访问，这颗按钮要么什么也不改，要么把完全访问
	 * 降回自动——都不是人点它时想要的。权限档是全局设置，和输入框旁那颗芯片改的是同一处。
	 */
	const offerAuto = settings?.permissionMode === "ask";

	// 和业务提问一样，卡片一出来焦点就在它身上，快捷键不用先点一下。
	useEffect(() => { cardRef.current?.focus(); }, []);

	async function answer(decision: ApprovalDecision, before?: () => Promise<void>) {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		try {
			await before?.();
			await respond(request.id, decision, sessionId ?? undefined);
		} catch (error) {
			busy.current = false;
			setPending(false);
			useApp.getState().notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
	const accept = () => void answer({ answer: approve });
	// 先换档再放行：批准那一刻 agent 就接着往下跑，第一步的工具调用该已经按自动档判。
	const acceptAuto = () => void answer({ answer: approve }, async () => { if (settings) await saveSettings({ ...settings, permissionMode: "auto" }); });
	const reject = () => void answer("reject");
	const feedback = planFeedback(comments, text);
	const revise = () => { if (feedback) void answer({ answer: feedback }); };
	const cancelRevise = () => {
		setRevising(false);
		setText("");
		cardRef.current?.focus();
	};

	function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
		if (event.nativeEvent.isComposing || revising) return;
		if (event.key === "Escape") {
			event.preventDefault();
			setRevising(true);
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (event.shiftKey || !offerAuto) accept();
			else acceptAuto();
		}
	}

	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc 与 ⌘↵ 作用于整张卡上的按钮。
		<div ref={cardRef} tabIndex={-1} onKeyDown={onKey} aria-busy={pending} data-approval-card="" data-approval-plan=""
			className="ly-glass flex max-h-[min(560px,calc(100dvh-14rem))] w-full max-w-[var(--ly-content)] flex-col gap-[var(--ly-composer-in)] overflow-hidden rounded-xl border border-line px-[var(--ly-composer-x)] pb-[var(--ly-composer-in)] pt-[var(--ly-composer-x)] outline-none">
			<div className="flex shrink-0 items-center gap-3">
				<span className="min-w-0 flex-1 truncate text-body font-medium text-ink" data-approval-title="">{t("plan.approvalTitle")}</span>
				{comments.length > 0 && <span className="shrink-0 text-caption text-ink-faint" data-approval-plan-comments="">{t("plan.commentCount", { n: comments.length })}</span>}
				{tags}
				{/* 一段可点的字，不是按钮的形状：标题行右端的链接，`Button` 没有强调色的字。 */}
				<button type="button" onClick={openPlan} className="shrink-0 cursor-pointer rounded text-detail text-accent hover:underline focus-visible:underline" data-approval-open-plan="">{t("plan.open")}</button>
			</div>
			{compact && <Scroller className="ly-approval-scroll -mx-2 min-h-0" contentClassName="px-2">{renderPlan(request.detail)}</Scroller>}
			{revising ? (
				<form className="flex shrink-0 flex-col gap-2" onSubmit={(event) => { event.preventDefault(); revise(); }}>
					<Textarea
						autoFocus
						rows={2}
						value={text}
						disabled={pending}
						placeholder={t("plan.revisePlaceholder")}
						aria-label={t("plan.revise")}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								revise();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								cancelRevise();
							}
						}}
						className="w-full resize-none rounded-lg bg-shell px-3 py-2 text-label leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
						data-plan-revise-input=""
					/>
					<div className="flex items-center justify-end gap-2">
						{comments.length > 0 && <span className="mr-auto text-caption text-ink-muted">{t("plan.commentsAttached", { n: comments.length })}</span>}
						<Button variant="soft" disabled={pending} onClick={cancelRevise}>{t("common.cancel")}<Keys keys={["Esc"]} /></Button>
						<Button type="submit" variant="primary" disabled={pending || !feedback} data-plan-send-revision="">{t("plan.sendRevision")}<Keys keys={["↩"]} /></Button>
					</div>
				</form>
			) : (
				<div className="flex shrink-0 flex-wrap items-center gap-2" data-approval-plan-actions="">
					<Button variant="soft" disabled={pending} onClick={reject} data-plan-action="reject">{t("plan.reject")}</Button>
					<Button variant="soft" disabled={pending} onClick={() => setRevising(true)} data-plan-action="revise">{t("plan.revise")}<Keys keys={["Esc"]} /></Button>
					<span className="flex-1" />
					<Button variant={offerAuto ? "soft" : "primary"} disabled={pending} onClick={accept} data-plan-action="accept">
						{t("plan.accept")}<Keys keys={offerAuto ? ["⇧", "⌘", "↩"] : ["⌘", "↩"]} />
					</Button>
					{offerAuto && <Button variant="primary" disabled={pending} onClick={acceptAuto} data-plan-action="accept-auto">{t("plan.acceptAuto")}<Keys keys={["⌘", "↩"]} /></Button>}
				</div>
			)}
		</div>
	);
}
