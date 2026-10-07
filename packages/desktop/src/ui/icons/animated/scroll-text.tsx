// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 scroll-text，悬停时两行字从上到下依次写出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (i: number) => ({ pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.3, delay: i * 0.12, ease: "easeInOut" } }),
};

export const ScrollTextIcon = forwardRef<SVGSVGElement, LucideProps>(function ScrollTextIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-scroll-text ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={1}
				variants={DRAW_VARIANTS}
				d="M15 12h-5"
			/>
			<M.path
				animate={controls}
				custom={0}
				variants={DRAW_VARIANTS}
				d="M15 8h-5"
			/>
			<path d="M19 17V5a2 2 0 0 0-2-2H4" />
			<path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
		</svg>
	);
});
