import type { ServerResponse } from "node:http";

/**
 * 手机聊天页验收用的那一轮「真干活」：更新计划、读文件、改文件、跑命令、收尾，再用带标题、
 * 列表和代码块的 Markdown 回答。每一步都走真实的 provider、工具执行和存储，手机看到的
 * 是和电脑同一份转录。
 *
 * 第几步按这句话之后已经回来几个工具结果来数，所以同一个会话里先问过别的也不影响。
 */
export const WORK_PROMPT = "DO_WORK";
export const WORK_ANSWER = "## 改好了\n\n手机端这次做了三件事：\n\n- 读了 `README.md`\n- 在标题下面加了一行说明\n- 数了一遍行数确认改动落地\n\n```ts\nexport const mobile = true;\n```\n\n有问题随时说。";

/** 回答前后两段之间停多久，比运行行的 STALL_MS 长一截，好拍到它回来。 */
export const ANSWER_PAUSE_MS = 3_500;

const STEPS: { name: string; input: object }[] = [
	{ name: "todo_write", input: { todos: [{ content: "读 README", status: "in_progress", activeForm: "正在读 README" }, { content: "加一行说明", status: "pending" }, { content: "确认文件", status: "pending" }] } },
	{ name: "read", input: { path: "README.md" } },
	{ name: "edit", input: { path: "README.md", old_string: "# Mobile QA", new_string: "# Mobile QA\n\n手机端改的这一行。\n第二行。" } },
	{ name: "bash", input: { command: "wc -l README.md", description: "数一下行数" } },
	{ name: "todo_write", input: { todos: [{ content: "读 README", status: "completed" }, { content: "加一行说明", status: "completed" }, { content: "确认文件", status: "completed" }] } },
];

/** 不是这一轮的请求返回 false，交给调用方的模型脚本。 */
export function replyWork(messages: unknown[], res: ServerResponse): boolean {
	const text = JSON.stringify(messages);
	const start = text.lastIndexOf(WORK_PROMPT);
	if (start < 0) return false;
	const done = text.slice(start).split('"tool_result"').length - 1;
	const step = STEPS[done];
	// 跑命令前停一会儿，好让验收能拍到任务进行中的样子（计划条、转圈的那一步）。
	setTimeout(() => void stream(res, step ? { tool: { id: `work-${done}`, ...step } } : { text: WORK_ANSWER }), step?.name === "bash" ? 1500 : 0);
	return true;
}

async function stream(res: ServerResponse, block: { tool?: { id: string; name: string; input: object }; text?: string }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	emit("message_start", { message: { id: "mobile-work", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: block.tool ? { type: "tool_use", id: block.tool.id, name: block.tool.name, input: {} } : { type: "text", text: "" } });
	if (block.tool) emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.tool.input) } });
	else {
		/*
		 * 回答分两段到，中间停 `ANSWER_PAUSE_MS`：验收要量到运行行在字落下时收起、字停住超过
		 * `STALL_MS`（2.5 秒）后回来——一次吐完的回答两件事都看不到。
		 */
		const split = block.text!.indexOf("\n\n- ");
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text!.slice(0, split) } });
		await new Promise((resolve) => setTimeout(resolve, ANSWER_PAUSE_MS));
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text!.slice(split) } });
	}
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: block.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}
