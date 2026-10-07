// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 arrow-up-down，悬停时两个箭头各朝自己指的方向推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DOWN_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, 2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const UP_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ArrowUpDownIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowUpDownIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-up-down ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={DOWN_VARIANTS}
			>
				<path d="m21 16-4 4-4-4" />
				<path d="M17 20V4" />
			</M.g>
			<M.g
				animate={controls}
				variants={UP_VARIANTS}
			>
				<path d="m3 8 4-4 4 4" />
				<path d="M7 4v16" />
			</M.g>
		</svg>
	);
});
