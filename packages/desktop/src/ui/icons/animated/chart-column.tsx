// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 chart-column，悬停时三根柱子从低到高依次长出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (i: number) => ({ pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.4, delay: i * 0.1, ease: "easeInOut" } }),
};

export const ChartColumnIcon = forwardRef<SVGSVGElement, LucideProps>(function ChartColumnIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-chart-column ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M3 3v16a2 2 0 0 0 2 2h16" />
			<M.path
				animate={controls}
				custom={2}
				variants={DRAW_VARIANTS}
				d="M18 17V9"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={DRAW_VARIANTS}
				d="M13 17V5"
			/>
			<M.path
				animate={controls}
				custom={0}
				variants={DRAW_VARIANTS}
				d="M8 17v-3"
			/>
		</svg>
	);
});
