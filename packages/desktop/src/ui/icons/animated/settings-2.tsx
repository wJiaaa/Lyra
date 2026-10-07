// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 settings-2，悬停时两个滑块朝相反方向拨一下，连着的那道线跟着缩短。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TRANSITION: Transition = { duration: 0.5, ease: "easeInOut" };

const TOP_KNOB_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 4, 0], transition: TRANSITION },
};

const BOTTOM_KNOB_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -4, 0], transition: TRANSITION },
};

// 线停在圆圈边上；圆圈挪过去时线不跟着收，就会从圆圈中间穿过去。
const TOP_LINE_VARIANTS: Variants = {
	normal: { d: "M19 7h-9" },
	animate: { d: ["M19 7h-9", "M19 7h-5", "M19 7h-9"], transition: TRANSITION },
};

const BOTTOM_LINE_VARIANTS: Variants = {
	normal: { d: "M14 17H5" },
	animate: { d: ["M14 17H5", "M10 17H5", "M14 17H5"], transition: TRANSITION },
};

export const Settings2Icon = forwardRef<SVGSVGElement, LucideProps>(function Settings2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("animate"),
		() => void controls.start("normal"),
	);

	return (
		<svg
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-settings-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={BOTTOM_LINE_VARIANTS}
				d="M14 17H5"
			/>
			<M.path
				animate={controls}
				variants={TOP_LINE_VARIANTS}
				d="M19 7h-9"
			/>
			<M.circle
				animate={controls}
				variants={BOTTOM_KNOB_VARIANTS}
				cx="17"
				cy="17"
				r="3"
			/>
			<M.circle
				animate={controls}
				variants={TOP_KNOB_VARIANTS}
				cx="7"
				cy="7"
				r="3"
			/>
		</svg>
	);
});
