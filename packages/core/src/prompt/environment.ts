/**
 * 今天是几号，跟在它所属的那条用户消息后面，而不是 system prompt 里或请求的最末尾。
 *
 * 不放 system prompt：provider 的前缀缓存从**最前面**开始逐段匹配，里面有一个每天变一次的字符串，
 * 意味着每天头一次请求，整个对话一个字节都用不上缓存。
 *
 * 也不接在最末尾：那样它永远是「最后一条用户消息」，而 DeepSeek 这类交错思考的模型会丢掉最后一条
 * 用户消息之前所有助手轮的推理。实测（opencode go Responses）：末尾带它时，下一次请求里上一轮的推理
 * 整段消失、只命中到上一次输入为止，上一轮写出的正文和工具参数全按未缓存重付；拿掉它，命中覆盖
 * 「上次输入＋上次输出」，未缓存只剩约 200 token。
 *
 * 所以日期取那条用户消息自己的时间戳：第一条真人消息后面一定有，之后只在日期变了的那条后面再出现。
 * 同一份历史每次渲染出一模一样的字节，跨天也不改动已有的前缀。
 *
 * **不进转录。** 它在请求拼装的时候产生，`log` 里没有它——渲染是确定的，不需要存。
 */

import type { Message } from "../types.ts";

/** 今天，按本地时区。模型的训练截止日期不是今天，这是它唯一的来源。 */
export function today(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 在每个新日期的第一条用户消息后面接上环境信息。
 *
 * 用 `<env>` 包起来并且说明它是什么：它在结构上是一条用户消息，不说清楚的话，模型会把它当成
 * 刚收到的指令。
 *
 * `synthetic` 标着它不是人说的——`clearActiveSkill`、纠正分类器、记忆抽取都按这个字段
 * 区分「谁在说话」，漏标会让一条日期播报被当成用户的一次发言。
 *
 * 历史里已经有的日期块（子代理把它存进了自己的 `view`）原样保留，并算作「已经说过的日期」。
 * 没有一条真人消息的历史（压缩后只剩摘要）接在第一条用户消息后面，模型照样知道今天几号。
 */
export function withEnvironment(messages: Message[]): Message[] {
	const humans = messages.filter((m) => m.role === "user" && !m.synthetic);
	const anchors = new Set<Message>(humans.length > 0 ? humans : messages.filter((m) => m.role === "user").slice(0, 1));
	const out: Message[] = [];
	let shown: string | undefined;
	for (let at = 0; at < messages.length; at++) {
		const message = messages[at];
		out.push(message);
		if (isEnvironmentMessage(message)) {
			shown = dateIn(message);
			continue;
		}
		if (!anchors.has(message) || isEnvironmentMessage(messages[at + 1])) continue;
		const date = today(Number.isFinite(message.timestamp) && message.timestamp > 0 ? new Date(message.timestamp) : new Date());
		if (date === shown) continue;
		shown = date;
		out.push({
			role: "user",
			content: [{ type: "text", text: `<env>\n今天是 ${date}。这是环境信息，不是用户的请求。\n</env>` }],
			timestamp: message.timestamp,
			synthetic: true,
		});
	}
	return out;
}

function dateIn(message: Message): string | undefined {
	const [only] = message.content;
	return only?.type === "text" ? /今天是 (\d{4}-\d{2}-\d{2})/.exec(only.text)?.[1] : undefined;
}

/**
 * 认出 `withEnvironment` 接上的那一条，和写法放在一起，改一处不会漏另一处。
 *
 * `synthetic` 的用户消息、唯一一块文本、以 `<env>` 开头。别的 synthetic 消息（纠正、技能收尾）
 * 会留在历史里，所以不能只看 `synthetic`。
 */
export function isEnvironmentMessage(message: Message | undefined): boolean {
	if (message?.role !== "user" || !message.synthetic) return false;
	const [only, ...rest] = message.content;
	return rest.length === 0 && only?.type === "text" && only.text.startsWith("<env>");
}
