// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 arrow-up-from-line，悬停时箭头往上提一下，离开底线。
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

export const ArrowUpFromLineIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowUpFromLineIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-up-from-line ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="m18 9-6-6-6 6" />
				<path d="M12 3v14" />
			</M.g>
			<path d="M5 21h14" />
		</svg>
	);
});
