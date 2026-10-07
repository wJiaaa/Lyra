// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 arrow-down-to-line，悬停时箭头往下落一下，碰到底线。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, 2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ArrowDownToLineIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowDownToLineIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-down-to-line ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="M12 17V3" />
				<path d="m6 11 6 6 6-6" />
			</M.g>
			<path d="M19 21H5" />
		</svg>
	);
});
