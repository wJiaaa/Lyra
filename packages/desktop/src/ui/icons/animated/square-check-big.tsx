// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 square-check-big，悬停时勾重新打一遍。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: { pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const SquareCheckBigIcon = forwardRef<SVGSVGElement, LucideProps>(function SquareCheckBigIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-square-check-big ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344" />
			<M.path
				animate={controls}
				variants={DRAW_VARIANTS}
				d="m9 11 3 3L22 4"
			/>
		</svg>
	);
});
