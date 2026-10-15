/**
 * 每个会话正在看的那份计划，和人在计划面板里留下的评论。
 *
 * 审批卡（`PlanApproval`）和右栏的计划面板是同一次审阅的两面：卡片管回答，面板管读和划线评论。计划正文也存在这里，
 * 不只从审批里读——批准以后审批没了，面板还要能接着把那份计划摆着。
 *
 * 按会话存，不按窗口：分屏时两边各有自己的审批、自己的面板，和 `delivery-review.ts` 一个道理。
 * 只放内存：面板是临时的（`ephemeral`），重启后审批本身也不在了，留着评论没有可交给谁的。
 */

import { create } from "zustand";
import { quoteBlock } from "../lib/quote.ts";

export interface PlanComment {
	id: string;
	/** 划下的那段字，原样。发给模型的就是它，不是位置。 */
	quote: string;
	/** 在面板正文里的字符位置，只用来把那段重新标出来。 */
	start: number;
	end: number;
	text: string;
}

interface PlanReview {
	/** 哪一次 `submit_plan` 审批。模型改完再交是新的一次，评论跟着清空。 */
	requestId: string;
	text: string;
	comments: PlanComment[];
}

interface PlanReviewState {
	/** 按会话。 */
	reviews: Readonly<Record<string, PlanReview>>;
	/** 记下这次审批的计划；是新的一次返回 true——只有这时才替人打开面板，人关掉以后不再追着开。 */
	show(sessionId: string, requestId: string, text: string): boolean;
	add(sessionId: string, comment: Omit<PlanComment, "id">): void;
	remove(sessionId: string, id: string): void;
}

export const usePlanReview = create<PlanReviewState>((set, get) => ({
	reviews: {},
	show(sessionId, requestId, text) {
		if (get().reviews[sessionId]?.requestId === requestId) return false;
		set((state) => ({ reviews: { ...state.reviews, [sessionId]: { requestId, text, comments: [] } } }));
		return true;
	},
	add(sessionId, comment) {
		const review = get().reviews[sessionId];
		if (!review) return;
		// 按在正文里的先后排：发出去的意见和计划同一个顺序读。
		const comments = [...review.comments, { ...comment, id: crypto.randomUUID() }].sort((a, b) => a.start - b.start);
		set((state) => ({ reviews: { ...state.reviews, [sessionId]: { ...review, comments } } }));
	},
	remove(sessionId, id) {
		const review = get().reviews[sessionId];
		if (!review) return;
		set((state) => ({ reviews: { ...state.reviews, [sessionId]: { ...review, comments: review.comments.filter((comment) => comment.id !== id) } } }));
	},
}));

/** 引文太长时只带开头：模型据此认出是哪一段就够了，整段搬过去只是重复它自己写的计划。 */
const QUOTE_LIMIT = 200;

/**
 * 评论排成打回理由。引文写成引用块，不加「对计划的评论」一类的话：它不随界面语言变，模型和对话里那一行都读得懂。
 * `said` 是人在卡片上另外写的那句，放在最前面。
 */
export function planFeedback(comments: readonly Pick<PlanComment, "quote" | "text">[], said = ""): string {
	const parts = comments.map(({ quote, text }) => {
		const flat = quote.replace(/\s+/g, " ").trim();
		const cut = [...flat].length > QUOTE_LIMIT ? `${[...flat].slice(0, QUOTE_LIMIT).join("")}…` : flat;
		// 引用块后面空一行再写评论，见 `quoteBlock`：紧跟着写会被 Markdown 并进引文。
		return `${quoteBlock(cut)}${text.trim()}`;
	});
	return [said.trim(), ...parts].filter(Boolean).join("\n\n");
}
