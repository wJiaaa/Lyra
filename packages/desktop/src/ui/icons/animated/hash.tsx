// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 hash，悬停时左右晃一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const WIGGLE_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -10, 7, -3.5, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const HashIcon = forwardRef<SVGSVGElement, LucideProps>(function HashIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-hash ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={WIGGLE_VARIANTS}
			>
				<line x1="4" x2="20" y1="9" y2="9" />
				<line x1="4" x2="20" y1="15" y2="15" />
				<line x1="10" x2="8" y1="3" y2="21" />
				<line x1="16" x2="14" y1="3" y2="21" />
			</M.g>
		</svg>
	);
});
