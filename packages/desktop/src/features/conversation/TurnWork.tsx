import type { ReactNode } from "react";

/**
 * 有过程的一轮：过程一行行摊在对话里，回答跟在最后（怎么分见 `grouping.ts` 的 `TurnBlock`）。
 *
 * 不再有整轮的锚（「已工作 N 秒」）和整轮折叠：跑着时它和底部运行指示说同一个数，跑完之前又问不出这一轮
 * 会不会有过程，挂早了没调工具的一轮也顶着一行，挂晚了是开口、调工具时突然冒出来；跑完收起又是一整段
 * 内容在眼前塌掉。一段段活本来就各自收成一行、说着里面有什么，够了。
 *
 * 每一行各自一个带 key 的盒子：一句中途说的话，说出来的时候站在回答的位置上，模型接着干活它就成了过程的
 * 一部分——位置不变，不卸掉重建。
 */
export function TurnWork({ entries }: {
	/** 这一轮里的每一行。 */
	entries: { key: string; node: ReactNode }[];
}) {
	return (
		<div data-ly-turn-process>
			{entries.map((entry, index) => (
				// 第一行贴着上面那行，和一句回答离它同一个距离。里面那行什么也没画出来（一条空正文的回复），
				// 这层行距跟着不要，否则看不见的一行在两行之间多空出 10px。
				<div key={entry.key} className={index === 0 ? "has-[>:empty]:hidden" : "pt-2.5 has-[>:empty]:hidden"}>
					{entry.node}
				</div>
			))}
		</div>
	);
}
