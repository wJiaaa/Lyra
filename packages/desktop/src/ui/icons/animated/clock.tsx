// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/clock.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const HAND_TRANSITION: Transition = {
	duration: 0.6,
	ease: [0.4, 0, 0.2, 1],
};

const HAND_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		originX: "0%",
		originY: "100%",
	},
	animate: {
		rotate: 360,
		originX: "0%",
		originY: "100%",
	},
};

const MINUTE_HAND_TRANSITION: Transition = {
	duration: 0.5,
	ease: "easeInOut",
};

// lucide 现在的分针朝右下（到 16,14），轴心 (12,12) 是它外框的左上角，不再是上游横线的左下角。
const MINUTE_HAND_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		originX: "0%",
		originY: "0%",
	},
	animate: {
		rotate: 45,
		originX: "0%",
		originY: "0%",
	},
};

export const ClockIcon = forwardRef<SVGSVGElement, LucideProps>(function ClockIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-clock ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.line
				animate={controls}
				initial="normal"
				transition={HAND_TRANSITION}
				variants={HAND_VARIANTS}
				x1="12"
				x2="12"
				y1="12"
				y2="6"
			/>
			<M.line
				animate={controls}
				initial="normal"
				transition={MINUTE_HAND_TRANSITION}
				variants={MINUTE_HAND_VARIANTS}
				x1="12"
				x2="16"
				y1="12"
				y2="14"
			/>
		</svg>
	);
});
