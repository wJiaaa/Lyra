// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/calendar-days.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DOTS = [
	{ cx: 8, cy: 13 },
	{ cx: 12, cy: 13 },
	{ cx: 16, cy: 13 },
	{ cx: 8, cy: 17 },
	{ cx: 12, cy: 17 },
	{ cx: 16, cy: 17 },
];

const VARIANTS: Variants = {
	normal: {
		opacity: 1,
		transition: {
			duration: 0.2,
		},
	},
	animate: (i: number) => ({
		opacity: [1, 0.3, 1],
		transition: {
			delay: i * 0.1,
			duration: 0.4,
			times: [0, 0.5, 1],
		},
	}),
};

export const CalendarDaysIcon = forwardRef<SVGSVGElement, LucideProps>(function CalendarDaysIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-calendar-days ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M8 2v3" />
			<path d="M16 2v3" />
			<rect height="18" rx="2" width="18" x="3" y="3" />
			<path d="M3 9h18" />
			{DOTS.map((dot, index) => (
				<M.path
					animate={controls}
					custom={index}
					d={`M${dot.cx} ${dot.cy}h.01`}
					initial="normal"
					key={`${dot.cx}-${dot.cy}`}
					variants={VARIANTS}
				/>
			))}
		</svg>
	);
});
