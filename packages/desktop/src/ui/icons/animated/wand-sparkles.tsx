// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 wand-sparkles，悬停时魔杖挥一下，三颗星依次闪。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const WAND_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -8, 0], transition: { duration: 0.5, ease: "easeInOut" } },
};

const SPARK_VARIANTS: Variants = {
	normal: { opacity: 1, scale: 1 },
	animate: (i: number) => ({ opacity: [1, 0.2, 1], scale: [1, 0.5, 1], transition: { duration: 0.4, delay: i * 0.1, ease: "easeInOut" } }),
};

export const WandSparklesIcon = forwardRef<SVGSVGElement, LucideProps>(function WandSparklesIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-wand-sparkles ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={WAND_VARIANTS}
				style={{ originX: 0, originY: 1 }}
			>
				<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
				<path d="m14 7 3 3" />
			</M.g>
			<M.g
				animate={controls}
				custom={1}
				variants={SPARK_VARIANTS}
			>
				<path d="M5 6v4" />
				<path d="M7 8H3" />
			</M.g>
			<M.g
				animate={controls}
				custom={2}
				variants={SPARK_VARIANTS}
			>
				<path d="M19 14v4" />
				<path d="M21 16h-4" />
			</M.g>
			<M.g
				animate={controls}
				custom={0}
				variants={SPARK_VARIANTS}
			>
				<path d="M10 2v2" />
				<path d="M11 3H9" />
			</M.g>
		</svg>
	);
});
