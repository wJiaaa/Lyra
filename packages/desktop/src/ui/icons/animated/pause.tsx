// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/pause.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const BASE_RECT_VARIANTS: Variants = {
	normal: {
		y: 0,
	},
};

const BASE_RECT_TRANSITION = {
	transition: {
		times: [0, 0.2, 0.5, 1],
		duration: 0.5,
		stiffness: 260,
		damping: 20,
	},
};

const LEFT_RECT_VARIANTS: Variants = {
	...BASE_RECT_VARIANTS,
	animate: {
		y: [0, 2, 0, 0],
		...BASE_RECT_TRANSITION,
	},
};

const RIGHT_RECT_VARIANTS: Variants = {
	...BASE_RECT_VARIANTS,
	animate: {
		y: [0, 0, 2, 0],
		...BASE_RECT_TRANSITION,
	},
};

export const PauseIcon = forwardRef<SVGSVGElement, LucideProps>(function PauseIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-pause ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				height="18"
				rx="1"
				variants={LEFT_RECT_VARIANTS}
				width="5"
				x="5"
				y="3"
			/>
			<M.rect
				animate={controls}
				height="18"
				rx="1"
				variants={RIGHT_RECT_VARIANTS}
				width="5"
				x="14"
				y="3"
			/>
		</svg>
	);
});
