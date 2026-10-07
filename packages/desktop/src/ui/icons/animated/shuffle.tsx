// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 shuffle，悬停时两个箭头往前推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: (i: number) => ({ x: [0, 1.5, 0], transition: { duration: 0.4, delay: i * 0.08, ease: "easeInOut" } }),
};

export const ShuffleIcon = forwardRef<SVGSVGElement, LucideProps>(function ShuffleIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-shuffle ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={1}
				variants={NUDGE_VARIANTS}
				d="m18 14 4 4-4 4"
			/>
			<M.path
				animate={controls}
				custom={0}
				variants={NUDGE_VARIANTS}
				d="m18 2 4 4-4 4"
			/>
			<path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
			<path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
			<path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
		</svg>
	);
});
