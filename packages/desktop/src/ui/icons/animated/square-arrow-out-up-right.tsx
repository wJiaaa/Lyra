// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 square-arrow-out-up-right，悬停时箭头往右上推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, 2, 0], y: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const SquareArrowOutUpRightIcon = forwardRef<SVGSVGElement, LucideProps>(function SquareArrowOutUpRightIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-square-arrow-out-up-right ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="m21 3-9 9" />
				<path d="M15 3h6v6" />
			</M.g>
		</svg>
	);
});
