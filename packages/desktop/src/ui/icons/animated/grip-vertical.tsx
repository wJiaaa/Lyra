// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/grip-vertical.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const CIRCLES = [
	{ cx: 9, cy: 5 },
	{ cx: 9, cy: 12 },
	{ cx: 9, cy: 19 },
	{ cx: 15, cy: 5 },
	{ cx: 15, cy: 12 },
	{ cx: 15, cy: 19 },
];

const ROWS = 3;

const VARIANTS: Variants = {
	normal: {
		opacity: 1,
		scale: 1,
		transition: { duration: 0.25, ease: "easeOut" },
	},
	animate: (data: { index: number }) => {
		const row = data.index % ROWS;
		const col = Math.floor(data.index / ROWS);
		const delay = row * 0.15 + col * (ROWS * 0.15 - 0.2);

		return {
			opacity: [1, 0.4, 1],
			scale: [1, 0.85, 1],
			transition: { delay, duration: 1, ease: "easeInOut" },
		};
	},
};

export const GripVerticalIcon = forwardRef<SVGSVGElement, LucideProps>(function GripVerticalIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-grip-vertical ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			{CIRCLES.map((circle, index) => (
				<M.circle
					animate={controls}
					custom={{ index }}
					cx={circle.cx}
					cy={circle.cy}
					initial="normal"
					key={`${circle.cx}-${circle.cy}`}
					r="1"
					variants={VARIANTS}
				/>
			))}
		</svg>
	);
});
