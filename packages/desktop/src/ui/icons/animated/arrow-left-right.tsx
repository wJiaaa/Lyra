// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 arrow-left-right，悬停时上下两个箭头各朝自己指的方向推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LEFT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ArrowLeftRightIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowLeftRightIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-left-right ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={LEFT_VARIANTS}
			>
				<path d="M8 3 4 7l4 4" />
				<path d="M4 7h16" />
			</M.g>
			<M.g
				animate={controls}
				variants={RIGHT_VARIANTS}
			>
				<path d="m16 21 4-4-4-4" />
				<path d="M20 17H4" />
			</M.g>
		</svg>
	);
});
