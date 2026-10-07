// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/arrow-left.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: { d: "m12 19-7-7 7-7", translateX: 0 },
	animate: {
		d: "m12 19-7-7 7-7",
		translateX: [0, 3, 0],
		transition: {
			duration: 0.4,
		},
	},
};

const SECOND_PATH_VARIANTS: Variants = {
	normal: { d: "M19 12H5" },
	animate: {
		d: ["M19 12H5", "M19 12H10", "M19 12H5"],
		transition: {
			duration: 0.4,
		},
	},
};

export const ArrowLeftIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowLeftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-left ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="m12 19-7-7 7-7"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M19 12H5"
				variants={SECOND_PATH_VARIANTS}
			/>
		</svg>
	);
});
