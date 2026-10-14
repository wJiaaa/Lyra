import { formatElapsed } from "@plume/client-runtime/running";
import { useEffect, useState } from "react";
import { translate } from "../../i18n/translate.ts";
import { RollWords } from "../../ui/motion/RollWords.tsx";

/*
 * 单独一个文件，不放在 `ThinkingBlock` 里：一段活的末尾也要用它（见 `WorkStep`），而 `ThinkingBlock`
 * 经 `Markdown` 连到停靠栏、再连回转录，从 `WorkStep` 引它就是一条新的循环依赖。
 */

/**
 * 运行中的词，按这一段已经想了多久往下走：`[从第几毫秒起, 词]`。
 *
 * 间隔越拉越长（8、12、20、30、40 秒）。短推理只会看到一两个词；长推理每一步都比上一步停得久，
 * 不会变成它曾经那种每隔几秒换一次字的吵。按时长选而不是随机，重绘、切会话回来重新挂载都是同一个词。
 */
const LIVE_STEPS = [
	[0, "thinking.live"],
	[8_000, "thinking.live3"],
	[20_000, "thinking.live2"],
	[40_000, "thinking.live4"],
	[70_000, "thinking.live5"],
	[110_000, "thinking.live6"],
] as const;

/** 走完一遍以后，每隔这么久再换一个。停在最后一个词上几分钟不动，看上去和卡住了一样。 */
const LIVE_CYCLE_MS = 20_000;

function liveWord(elapsedMs: number): (typeof LIVE_STEPS)[number][1] {
	const last = LIVE_STEPS.length - 1;
	const lastAt = LIVE_STEPS[last][0];
	if (elapsedMs >= lastAt) {
		// 轮回时跳过开场的「正在思考」：想了两分钟以后再说一遍它，读着像刚开始。
		const round = Math.floor((elapsedMs - lastAt) / LIVE_CYCLE_MS);
		return LIVE_STEPS[1 + ((last - 1 + round) % last)][1];
	}
	let step = 0;
	while (step < last && elapsedMs >= LIVE_STEPS[step + 1][0]) step++;
	return LIVE_STEPS[step][1];
}

/**
 * 运行中那一行：「正在思考 · 5s」。
 *
 * 自己走钟，只重绘这一小块——放在 `ThinkingBlock` 里的话，每次走秒都把展开着的正文一起重绘一遍。
 * 四分之一秒一跳，和运行指示一样，秒位不会看上去跳过一格。
 *
 * 换词时新词从上方落进来，词框的宽度跟着平滑地变，后面的秒数被推过去而不是跳过去（`RollWords`）。
 * 秒数本身不滚：它是读数不是标签，每秒滚一次就成了眼角一直在动的东西（见 `RollingText`）。
 *
 * 说不出开始时刻时不报秒，词停在第一个。
 */
export function LiveThought({ startedAt }: { startedAt: number | undefined }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [startedAt]);

	const elapsed = startedAt === undefined ? 0 : now - startedAt;
	const word = translate(liveWord(elapsed));
	return (
		<span className="inline-flex items-center">
			<RollWords rollKey={word} glide>
				{word}
			</RollWords>
			{startedAt !== undefined && (
				<>
					<span className="ly-flow-dot" aria-hidden />
					<span className="tabular-nums">{formatElapsed(elapsed)}</span>
				</>
			)}
		</span>
	);
}
