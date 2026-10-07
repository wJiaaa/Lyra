// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/chart-line.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
	},
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			delay: 0.15,
			duration: 0.3,
			opacity: { delay: 0.1 },
		},
	},
};

export const ChartLineIcon = forwardRef<SVGSVGElement, LucideProps>(function ChartLineIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-chart-line ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M3 3v16a2 2 0 0 0 2 2h16" />
			<M.path
				animate={controls}
				d="m7 13 3-3 4 4 5-5"
				variants={VARIANTS}
			/>
		</svg>
	);
});
