// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/link.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	initial: { pathLength: 1, pathOffset: 0, rotate: 0 },
	animate: {
		pathLength: [1, 0.97, 1, 0.97, 1],
		pathOffset: [0, 0.05, 0, 0.05, 0],
		rotate: [0, -5, 0],
		transition: {
			rotate: {
				duration: 0.5,
			},
			duration: 1,
			times: [0, 0.2, 0.4, 0.6, 1],
			ease: "easeInOut",
		},
	},
};

export const LinkIcon = forwardRef<SVGSVGElement, LucideProps>(function LinkIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-link ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
