// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/arrow-right.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: { d: "M5 12h14" },
	animate: {
		d: ["M5 12h14", "M5 12h9", "M5 12h14"],
		transition: {
			duration: 0.4,
		},
	},
};

const SECONDARY_PATH_VARIANTS: Variants = {
	normal: { d: "m12 5 7 7-7 7", translateX: 0 },
	animate: {
		d: "m12 5 7 7-7 7",
		translateX: [0, -3, 0],
		transition: {
			duration: 0.4,
		},
	},
};

export const ArrowRightIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowRightIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-right ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M5 12h14"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="m12 5 7 7-7 7"
				variants={SECONDARY_PATH_VARIANTS}
			/>
		</svg>
	);
});
