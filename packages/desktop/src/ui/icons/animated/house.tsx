// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/home.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	duration: 0.6,
	opacity: { duration: 0.2 },
};

const PATH_VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
	},
};

export const HouseIcon = forwardRef<SVGSVGElement, LucideProps>(function HouseIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-house ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
			<M.path
				animate={controls}
				d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"
				transition={DEFAULT_TRANSITION}
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
