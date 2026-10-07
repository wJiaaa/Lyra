// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 info，悬停时字母 i 跳一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const InfoIcon = forwardRef<SVGSVGElement, LucideProps>(function InfoIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-info ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="M12 16v-4" />
				<path d="M12 8h.01" />
			</M.g>
		</svg>
	);
});
