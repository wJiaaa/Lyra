// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 octagon-pause，悬停时两道竖线依次收一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const BAR_VARIANTS: Variants = {
	normal: { scaleY: 1 },
	animate: (i: number) => ({ scaleY: [1, 0.6, 1], transition: { duration: 0.4, delay: i * 0.1, ease: "easeInOut" } }),
};

export const OctagonPauseIcon = forwardRef<SVGSVGElement, LucideProps>(function OctagonPauseIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-octagon-pause ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={0}
				variants={BAR_VARIANTS}
				d="M10 15V9"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={BAR_VARIANTS}
				d="M14 15V9"
			/>
			<path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z" />
		</svg>
	);
});
