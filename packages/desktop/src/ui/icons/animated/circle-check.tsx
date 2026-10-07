// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/circle-check.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		transition: {
			duration: 0.3,
			opacity: { duration: 0.1 },
		},
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
		transition: {
			duration: 0.4,
			opacity: { duration: 0.1 },
		},
	},
};

export const CircleCheckIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleCheckIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-check ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.path
				animate={controls}
				d="M8 12l2.5 2.5L16 9"
				initial="normal"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
