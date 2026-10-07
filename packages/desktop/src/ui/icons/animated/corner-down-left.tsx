// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/corner-down-left.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const STRETCH_VARIANTS: Variants = {
	normal: { scaleX: 1, x: 0, opacity: 1 },
	animate: {
		scaleX: [1, 1.15, 1],
		x: [0, -2, 0],
		transition: {
			duration: 0.45,
			ease: "easeInOut",
		},
	},
};

export const CornerDownLeftIcon = forwardRef<SVGSVGElement, LucideProps>(function CornerDownLeftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("animate"),
		() => void controls.start("normal"),
	);

	return (
		<M.svg
			animate={controls}
			fill="none"
			height={size}
			initial="normal"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			variants={STRETCH_VARIANTS}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-corner-down-left ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="M4 15h12a4 4 0 0 0 4-4V4" />
			<path d="m9 20-5-5 5-5" />
		</M.svg>
	);
});
