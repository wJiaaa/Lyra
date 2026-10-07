// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/arrow-down-left.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const HEAD_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 3, 0],
		translateY: [0, -3, 0],
		transition: {
			duration: 0.5,
			ease: "easeInOut",
		},
	},
};

const SHAFT_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0, scale: 1 },
	animate: {
		translateX: [0, 3, 0],
		translateY: [0, -3, 0],
		scale: [1, 0.85, 1],
		originX: 1,
		originY: 1,
		transition: {
			duration: 0.5,
			ease: "easeInOut",
		},
	},
};

export const ArrowDownLeftIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowDownLeftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-down-left ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M17 17H7V7"
				variants={HEAD_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M7 17 L12 12"
				variants={SHAFT_VARIANTS}
			/>
			<path d="M17 7 L12 12" />
		</svg>
	);
});
