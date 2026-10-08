import type { Message } from "@plume/client-runtime";

export interface Step { id: string; name: string; args: unknown; output?: string; details?: unknown; failed: boolean; done: boolean }
interface FeedImage { data: string; mimeType: string }
export type FeedItem =
	/** `text` 是气泡里给人看的那句，`prompt` 是当初发给模型的原文——重试要发的是后者。 */
	| { kind: "user"; key: string; text: string; prompt: string; images: FeedImage[]; timestamp: number }
	| { kind: "text"; key: string; text: string }
	| { kind: "thinking"; key: string; text: string; live: boolean }
	| { kind: "steps"; key: string; steps: Step[]; live: boolean }
	| { kind: "error"; key: string; text: string; retry?: string }
	/** 一轮做完以后，最终回答之前的思考和工具调用收成这一行；`children` 是展开后的原样内容。 */
	| { kind: "fold"; key: string; children: FeedItem[]; steps: Step[]; thinking: number; durationMs: number }
	| { kind: "footer"; key: string; text: string; timestamp: number; durationMs: number };

type Turn = { user: Extract<FeedItem, { kind: "user" }> | null; items: FeedItem[]; start: number; end: number };

/**
 * 把消息序列拍平成手机上的一行行，再按「一轮」收拢。
 *
 * 工具调用和它的结果在存储里是两条消息，中间可能还夹着别的调用；手机上它们是同一行「一步」，
 * 结果按 toolCallId 回填。相邻的步骤并进同一组，正文或思考把组切开。
 *
 * 一轮从一句用户消息到下一句。做完的那一轮只留最终回答，前面的过程折成一行「已工作 1:23」
 * ——和桌面同一个做法：回头翻的时候要看的是结论，过程想看再点开。正在跑的那一轮不折，
 * 正在发生的事收进一行摘要里，等于什么都没告诉人。
 */
export function buildFeed(messages: Message[], running = false): FeedItem[] {
	const turns: Turn[] = [];
	const byId = new Map<string, Step>();
	let turn: Turn | null = null;
	const open = (user: Turn["user"], at: number) => { turn = { user, items: [], start: at, end: at }; turns.push(turn); return turn; };
	messages.forEach((message, index) => {
		const base = `${message.timestamp}-${index}`;
		if (message.role === "user") {
			const prompt = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
			const images = message.content.flatMap((part) => part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : []);
			// 桌面在正文后面缀的会话引用、技能展开是写给模型的；人发的那句存在 displayText 里，和桌面气泡一样只画它。
			open({ kind: "user", key: base, text: message.displayText ?? prompt, prompt, images, timestamp: message.timestamp }, message.timestamp);
			return;
		}
		const current: Turn = turn ?? open(null, message.timestamp);
		const ended = message.role === "assistant" ? message.timestamp + (message.durationMs ?? 0) : message.timestamp;
		current.end = Math.max(current.end, ended);
		if (message.role === "toolResult") {
			const step = byId.get(message.toolCallId);
			if (!step) return;
			step.output = message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
			step.details = message.details;
			step.failed = !!message.isError;
			step.done = true;
			return;
		}
		message.content.forEach((part, offset) => {
			const key = `${base}-${offset}`;
			if (part.type === "text") { if (part.text.trim()) current.items.push({ kind: "text", key, text: part.text }); return; }
			if (part.type === "thinking") { if (part.thinking.trim()) current.items.push({ kind: "thinking", key, text: part.thinking, live: false }); return; }
			const step: Step = { id: part.id, name: part.name, args: part.arguments, failed: false, done: false };
			byId.set(part.id, step);
			const last = current.items.at(-1);
			if (last?.kind === "steps") last.steps.push(step);
			else current.items.push({ kind: "steps", key, steps: [step], live: false });
		});
		if (message.stopReason === "error" && message.errorMessage) current.items.push({ kind: "error", key: `${base}-error`, text: message.errorMessage });
	});
	return turns.flatMap((each, index) => settle(each, running && index === turns.length - 1, index === turns.length - 1));
}

function settle(turn: Turn, live: boolean, last: boolean): FeedItem[] {
	const head: FeedItem[] = turn.user ? [turn.user] : [];
	const durationMs = Math.max(0, turn.end - turn.start);
	if (live) {
		const tail = turn.items.at(-1);
		for (const item of turn.items) if (item.kind === "steps") item.live = true;
		if (tail?.kind === "thinking") tail.live = true;
		return [...head, ...turn.items];
	}
	// 只有最后一轮的错误给「重试」：更早的那句早就被后来的对话接过去了，再发一遍是另一件事。
	if (last && turn.user?.prompt.trim() && !turn.user.images.length) for (const item of turn.items) if (item.kind === "error") item.retry = turn.user.prompt;
	let cut = turn.items.length;
	while (cut > 0 && (turn.items[cut - 1]!.kind === "text" || turn.items[cut - 1]!.kind === "error")) cut--;
	const process = turn.items.slice(0, cut);
	const final = turn.items.slice(cut);
	const steps = process.flatMap((item) => item.kind === "steps" ? item.steps : []);
	const thinking = process.filter((item) => item.kind === "thinking").length;
	const body: FeedItem[] = steps.length || thinking
		? [{ kind: "fold", key: `${process[0]!.key}-fold`, children: process, steps, thinking, durationMs }, ...final]
		: turn.items;
	const answer = final.filter((item) => item.kind === "text").map((item) => item.text).join("\n\n");
	if (answer) body.push({ kind: "footer", key: `${final.at(-1)!.key}-footer`, text: answer, timestamp: turn.end, durationMs });
	return [...head, ...body];
}

/** 展开的那几轮把原样内容接在摘要行后面，列表始终是平的，虚拟化照常工作。 */
export function flatten(feed: FeedItem[], expanded: ReadonlySet<string>): { item: FeedItem; nested: boolean }[] {
	return feed.flatMap((item) => item.kind === "fold" && expanded.has(item.key)
		? [{ item, nested: false }, ...item.children.map((child) => ({ item: child, nested: true }))]
		: [{ item, nested: false }]);
}

/** 详情面板按 id 盯着那一步：结果是后到的，面板开着时也要换成带结果的那一份。 */
export function findStep(feed: FeedItem[], id: string): Step | null {
	for (const item of feed) {
		const steps = item.kind === "steps" ? item.steps : item.kind === "fold" ? item.steps : [];
		const hit = steps.find((step) => step.id === id);
		if (hit) return hit;
	}
	return null;
}
