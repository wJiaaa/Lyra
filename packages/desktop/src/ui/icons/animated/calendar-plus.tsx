// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 calendar-plus，悬停时加号转半圈，和 plus 同一套弹簧。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PLUS_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: 180 },
};

const SPRING: Transition = { type: "spring", stiffness: 100, damping: 15 };

export const CalendarPlusIcon = forwardRef<SVGSVGElement, LucideProps>(function CalendarPlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-calendar-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={PLUS_VARIANTS}
				transition={SPRING}
			>
				<path d="M16 18h6" />
				<path d="M19 15v6" />
			</M.g>
			<path d="M16 2v3" />
			<path d="M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3" />
			<path d="M3 9h18" />
			<path d="M8 2v3" />
		</svg>
	);
});
