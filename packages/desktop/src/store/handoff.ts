/**
 * 被「现在就发」打断、马上要拿那句话重新开始的会话。
 *
 * 运行时先停下旧的那一轮（`agent_end`，reason 是 aborted），等它完全放手，再提交那句话、开新的一轮
 * （`agent_start`）。两件事之间隔着几十毫秒，而 `agent_end` 照字面读就是「停下了」：转录尾巴上闪一下
 * 「已暂停 · 继续」，停止按钮变回发送，计时清零又接上。实测三帧。人按的是「换一句话接着做」，不是停止，
 * 这一下闪烁说的是一件没发生的事。
 *
 * 所以发出去的时候记一笔，那一轮的 `agent_end` 认出它，只落定转录（半截回复照样标成被停下），不把会话
 * 放下。只认一次：之后再来的 `agent_end`——比如这几十毫秒里人又按了停止——照常处理。新一轮的
 * `agent_start` 把没用上的记号收掉：会话在打断送到之前已经自己跑完了，那就没有可认的。
 */

const pending = new Set<string>();

export function expectHandoff(sessionId: string): void {
	pending.add(sessionId);
}

export function dropHandoff(sessionId: string): void {
	pending.delete(sessionId);
}

/** 这个 `agent_end` 是不是被「现在就发」停下的那一轮的收尾；是的话记号就此用掉。 */
export function takeHandoff(sessionId: string): boolean {
	return pending.delete(sessionId);
}
