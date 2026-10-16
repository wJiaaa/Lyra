import { useLayoutEffect, useState } from "react";

import { motionReduced } from "../../ui/motion/reduced.ts";
import { RunningIndicator } from "./RunningIndicator.tsx";

/**
 * The 「运行中」 line under the transcript, folding in and out with the turn.
 *
 * What it shows outlives the turn by one fold. The row's `data-open` and its content used to be the
 * same condition, so a turn that ended without prose — only tools, stopped, failed — or a compaction
 * starting emptied the row in the frame the fold began: the fold had nothing left to animate, and a
 * transcript pinned to the bottom dropped the row's whole height at once. Now the indicator stays
 * until the fold has finished, and only then goes.
 *
 * 回答在来的时候它只是看不见，位置照旧占着。
 *
 * 看不见是当帧的，不淡出。第一行字挂在它上面，它被挤下去一行，词也同一帧从「Thinking」换成
 * 「Writing」——淡出的那 150ms 里，人看到的是字底下冒出来一行新的，又跟着转录往上滑着消失。
 * 停顿后长回来照旧淡入：那是它自己在原地出现，没有别的东西在动。
 *
 * 从前回答一开始它就当帧收起，指望和第一行字「一增一减抵掉」。抵不掉：正文由 `useSmoothText` 逐帧
 * 放出来，比这一行收起晚一到四帧，于是贴底的转录先掉下去 30px、再被字顶回来；回答停顿超过
 * `STALL_MS` 它又长回来，把转录往上推 30px，字接着来再掉一次。一轮里高度不变，这些就都不会发生。
 *
 * 回答写完（`answered`）时它当帧收起，不走过渡：回答底下那一行时间和复制按钮正是在这一次提交里
 * 长出来的，两者一出一进，转录只挪两者的差（实测 8px）。慢慢收的话，刚读完的那段话会先被操作行
 * 顶上去 38px、再随着这一行变矮往下沉 30px。
 */
export function RunningRow({ running, answering, answered, compacting }: {
	running: boolean;
	answering: boolean;
	/**
	 * 最后一条是一段正常写完的回答。收尾时消息先定稿、`answering` 先变回 false，`running` 晚一次提交
	 * 才落下——只看 `answering`，这一行会在收尾前一刻亮一下。
	 */
	answered: boolean;
	compacting: boolean;
}) {
	const open = running && !compacting && !answered;
	const [retained, setRetained] = useState(open);
	useLayoutEffect(() => {
		if (open) setRetained(true);
		else if (answered || motionReduced()) setRetained(false);
	}, [open, answered]);
	// A hidden `Activity` cancels the fold before its `transitionend`; see the same release in `Collapse`.
	useLayoutEffect(() => () => setRetained(false), []);
	return (
		<div
			className="ly-reveal"
			data-open={open}
			aria-hidden={!open || answering}
			style={answered ? { transition: "none" } : undefined}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) setRetained(false);
			}}
		>
			<div>
				<div
					data-ly-running-quiet={(open && answering) || undefined}
					className={`transition-opacity ${open && answering ? "opacity-0 duration-0" : "duration-[var(--ly-t-base)]"}`}
				>
					{((running && !compacting && !answered) || retained) && <RunningIndicator />}
				</div>
			</div>
		</div>
	);
}
