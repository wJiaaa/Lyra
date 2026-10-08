/**
 * Whether the answer is arriving *right now*, which is the only reason to take the running line away.
 *
 * The line folds while prose streams in, and that is right: words landing on screen are a better
 * report of progress than a phrase about progress. But "the answer is arriving" is a statement about
 * this moment, and it used to be answered with a question about the whole message — does it contain
 * any text at all. Those come apart in the most ordinary shape there is:
 *
 *     content: [ {text: "先看看这个文件"}, {toolCall: read …} ]
 *
 * One assistant message, still `pending`, holding a sentence *and* a call. Every turn where the
 * model says what it is about to do looks like this, and under the old reading the line folded at
 * the first word and stayed folded for the whole of the work that followed — a minute, five minutes,
 * however long the tools took. Meanwhile the composer went on showing 停止. Two halves of one window
 * disagreeing about whether anything was happening, and the quiet half was the one being believed:
 * people concluded the turn had finished and started typing again.
 *
 * So the question is asked of the tail, and asked again over time:
 *
 *   - The last block is what is being written. A call appended after the prose means the writing is
 *     over and the work has started, whatever came before it in the same message.
 *   - Prose that stops growing has stopped arriving. A stalled stream, a long pause between
 *     paragraphs, a provider that has gone quiet — all of them leave text as the last block forever,
 *     and none of them are the answer still coming in.
 */

// 判断本身挪到了 `@plume/client-runtime/running`：手机消息流末尾那一行要和这里同时收起、同时回来。
export { proseLength, STALL_MS } from "@plume/client-runtime/running";
