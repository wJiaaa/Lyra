// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/corner-right-down.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const STRETCH_VARIANTS: Variants = {
	normal: { scaleY: 1, y: 0, opacity: 1 },
	animate: {
		scaleY: [1, 1.15, 1],
		y: [0, 2, 0],
		transition: {
			duration: 0.45,
			ease: "easeInOut",
		},
	},
};

export const CornerRightDownIcon = forwardRef<SVGSVGElement, LucideProps>(function CornerRightDownIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-corner-right-down ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="m10 15 5 5 5-5" />
			<path d="M4 4h7a4 4 0 0 1 4 4v12" />
		</M.svg>
	);
});
