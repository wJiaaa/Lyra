// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/at-sign.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const CIRCLE_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		pathOffset: 0,
		transition: {
			duration: 0.4,
			opacity: { duration: 0.1 },
		},
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
		pathOffset: [1, 0],
		transition: {
			duration: 0.3,
			opacity: { duration: 0.1 },
		},
	},
};

const PATH_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		transition: {
			delay: 0.3,
			duration: 0.3,
			opacity: { duration: 0.1, delay: 0.3 },
		},
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
		transition: {
			delay: 0.3,
			duration: 0.3,
			opacity: { duration: 0.1, delay: 0.3 },
		},
	},
};

export const AtSignIcon = forwardRef<SVGSVGElement, LucideProps>(function AtSignIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-at-sign ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				cx="12"
				cy="12"
				r="4"
				variants={CIRCLE_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
