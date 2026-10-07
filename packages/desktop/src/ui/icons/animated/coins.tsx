// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 coins，悬停时后面那枚硬币往上跳一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const CoinsIcon = forwardRef<SVGSVGElement, LucideProps>(function CoinsIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-coins ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M13.744 17.736a6 6 0 1 1-7.48-7.48" />
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="M15 6h1v4" />
				<circle cx="16" cy="8" r="6" />
			</M.g>
			<path d="m6.134 14.768.866-.5 2 3.464" />
		</svg>
	);
});
