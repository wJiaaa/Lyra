import assert from "node:assert/strict";
import { test } from "node:test";

import { readSseWithIdleTimeout, type SseFrame } from "../src/utils/sse.ts";

const encoder = new TextEncoder();

/** 按给定的块原样发出去的响应，块之间可以停顿。 */
function chunked(chunks: string[], gapMs = 0, onCancel?: () => void): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				if (gapMs > 0 && index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
				controller.enqueue(encoder.encode(chunks[index++]));
			},
			cancel() {
				onCancel?.();
			},
		}),
	);
}

async function frames(response: Response, idleMs = 10_000, state = { tripped: false }): Promise<SseFrame[]> {
	const seen: SseFrame[] = [];
	for await (const frame of readSseWithIdleTimeout(response, undefined, idleMs, state)) seen.push(frame);
	return seen;
}

test("只用 \\r 做行尾的流也能切成帧", async () => {
	const seen = await frames(chunked(["event: a\rdata: 1\r\rdata: 2\r\r"]));
	assert.deepEqual(seen, [{ event: "a", data: "1" }, { event: undefined, data: "2" }]);
});

test("\\n\\r\\n 混着写的分隔符也是帧边界，两帧不会拼成一帧", async () => {
	const seen = await frames(chunked(["data: 1\n\r\ndata: 2\r\n\ndata: 3\n\n"]));
	assert.deepEqual(seen.map((frame) => frame.data), ["1", "2", "3"]);
});

test("\\r\\n 被块边界劈开时仍是一个换行，不会多切出一帧", async () => {
	// 第一块恰好停在 `\r` 上：先把它当成单独的行尾，接上下一块的 `\n` 就成了空行，一帧被切成两半。
	const seen = await frames(chunked(["data: a\r", "\ndata: b\r\n\r\n"]));
	assert.deepEqual(seen.map((frame) => frame.data), ["a\nb"]);
});

test("流以单独的 \\r 结尾时，最后一帧照样交出来", async () => {
	const seen = await frames(chunked(["data: last\r"]));
	assert.deepEqual(seen.map((frame) => frame.data), ["last"]);
});

test("只有注释行的保活也算活着，空闲闸不会把它当成死流", async () => {
	// `: keepalive`、OpenRouter 的 `: OPENROUTER PROCESSING` 都不产出帧，但字节一直在到。
	const keepalive = Array(8).fill(": OPENROUTER PROCESSING\n\n");
	const state = { tripped: false };
	const seen = await frames(chunked([...keepalive, "data: done\n\n"], 25), 80, state);
	assert.equal(state.tripped, false, "保活一直在发，闸不该落下");
	assert.deepEqual(seen.map((frame) => frame.data), ["done"]);
});

test("真的一个字节都不来，空闲闸照旧落下", async () => {
	const state = { tripped: false };
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: 1\n\n"));
				// 之后再也不发，也不关。
			},
		}),
	);
	const seen = await frames(response, 50, state);
	assert.equal(state.tripped, true);
	assert.deepEqual(seen.map((frame) => frame.data), ["1"]);
});

test("消费方提前离开时取消底层连接，而不是只松开读锁", async () => {
	let cancelled = false;
	const response = chunked(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"], 0, () => {
		cancelled = true;
	});
	for await (const frame of readSseWithIdleTimeout(response, undefined, 10_000, { tripped: false })) {
		assert.equal(frame.data, "1");
		break;
	}
	assert.equal(cancelled, true, "上游还在生成，连接得关掉");
});

test("读完的流不再多取消一次", async () => {
	let cancelled = false;
	const seen = await frames(chunked(["data: 1\n\n"], 0, () => {
		cancelled = true;
	}));
	assert.deepEqual(seen.map((frame) => frame.data), ["1"]);
	assert.equal(cancelled, false);
});
