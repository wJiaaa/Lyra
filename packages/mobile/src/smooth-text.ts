import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * 正在输出的回复，按匀速把字放出来，并给刚放出来的字一个淡入——照桌面 `useSmoothText` + `FadeText`。
 *
 * 字到达的节奏是服务商的、再加上一跳中转：有的每个 token 一帧，有的攒几百毫秒一次倒出一两百字，
 * 照原样画就是停住、整句蹦出来、再停住。速度和桌面同一套：取「平滑过的到达速率」和「积压量 /
 * `CATCH_UP`」中较大的，上游多快屏幕都最多落后约 `CATCH_UP` 秒。
 *
 * 淡入和桌面做法不同，结果相同：桌面给每个新字一个 CSS 动画；React Native 的嵌套 Text 不能单独做
 * 透明度动画，所以这里每帧重画末尾那几个字的颜色——放出来的那一刻记下时间，按过去多久算透明度，
 * 淡完的字从 `tail` 里移走。帧本来就在为放字而跑，淡入不另开动画。
 *
 * **写完不等于演完。** `live` 变成 false 时没放出来的字照常放完、最后一个字淡完，才交出
 * `active: false`，调用方这时才换回原文。
 */

/** 积压的字要在大约这么多秒内放完；也就是稳定输出时屏幕落后模型的时间。和桌面同一个数。 */
const CATCH_UP = 0.15;
/** 积压很少时的最低速度（字/秒），免得最后几个字拖着出来。 */
const FLOOR = 60;
/** 到达速率的上限（字/秒）。一次倒进来一大段时，瞬时速率高得没有意义，别让它把平滑冲掉。 */
const RATE_CAP = 1000;
/** 一次进来这么多字就不是在「输出」了（重连、补发、刚打开会话），直接给全文。 */
const JUMP = 2000;
/** 一个字淡入要多久，和桌面 `FadeText` 的 `FADE` 同一个数。 */
const FADE = 180;
/** 同一帧放出的字铺开多久：一帧里一次出来二十个字时，从左到右淡进来，而不是同时浮现。 */
const FRAME = 16;

export interface SmoothText {
	text: string;
	active: boolean;
	/** `text` 末尾还在淡入的那几个字（按码点）各自的不透明度，从前到后。 */
	tail: number[];
}

export function useSmoothText(text: string, live: boolean): SmoothText {
	const motion = !useReducedMotion();
	const [, redraw] = useState(0);
	const state = useRef({ target: text, position: text.length, cut: text.length, rate: 0, arrived: 0, frame: 0, last: 0, now: 0, live, active: live && motion, births: [] as number[] });

	useEffect(() => {
		const here = state.current;
		const now = performance.now();
		here.live = live;
		// 没在演、不是往后接着写、或者一次来得太多：直接给全文。
		if (!motion || !text.startsWith(here.target) || text.length - here.target.length > JUMP || (!live && !here.active)) {
			cancelAnimationFrame(here.frame);
			Object.assign(here, { frame: 0, target: text, position: text.length, cut: text.length, rate: 0, arrived: now, births: [], active: live && motion });
			redraw((n) => n + 1);
			return;
		}
		here.active = true;
		if (text !== here.target) {
			const added = text.length - here.target.length;
			// 第一批没有「上一批」可比，只能靠积压量那一项。
			if (here.arrived) here.rate = here.rate * 0.7 + Math.min(RATE_CAP, added / Math.max(0.016, (now - here.arrived) / 1000)) * 0.3;
			here.arrived = now;
			here.target = text;
		}
		if (here.frame) return;
		here.last = now;
		const step = (time: number) => {
			const current = state.current;
			// 夹住，免得切到后台再回来时把缺席的那段时间一帧花完。
			const delta = Math.min(0.1, Math.max(0, (time - current.last) / 1000));
			current.last = time;
			current.now = time;
			const backlog = current.target.length - current.position;
			if (backlog > 0) {
				current.position = Math.min(current.target.length, current.position + Math.max(FLOOR, current.rate, backlog / CATCH_UP) * delta);
				let cut = Math.floor(current.position);
				// 不切在一个代理对中间，否则 emoji 会先露出半个乱码。
				const code = current.target.charCodeAt(cut);
				if (code >= 0xdc00 && code <= 0xdfff) cut++;
				if (cut > current.cut) {
					const fresh = Array.from(current.target.slice(current.cut, cut)).length;
					for (let index = 0; index < fresh; index++) current.births.push(time + (index * FRAME) / fresh);
					current.cut = cut;
				}
			}
			while (current.births.length > 0 && time - current.births[0]! >= FADE) current.births.shift();
			if (backlog <= 0 && current.births.length === 0) {
				current.frame = 0;
				if (!current.live) current.active = false;
			} else current.frame = requestAnimationFrame(step);
			redraw((n) => n + 1);
		};
		here.frame = requestAnimationFrame(step);
	}, [text, live, motion]);

	useEffect(() => () => cancelAnimationFrame(state.current.frame), []);

	const here = state.current;
	if (!here.active) return { text, active: false, tail: [] };
	return {
		text: here.target.slice(0, here.cut),
		active: true,
		tail: here.births.map((birth) => {
			const progress = Math.min(1, Math.max(0, (here.now - birth) / FADE));
			return progress * progress * (3 - 2 * progress);
		}),
	};
}

/** 系统的「减弱动态效果」：开着时不放字也不淡入，来多少画多少。 */
function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		let alive = true;
		void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive) setReduced(value); });
		const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
		return () => { alive = false; subscription.remove(); };
	}, []);
	return reduced;
}
