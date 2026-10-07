// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/arrow-up-left.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ARROW_VARIANTS: Variants = {
	normal: {
		scale: 1,
		translateX: 0,
		translateY: 0,
	},
	animate: {
		scale: [1, 0.85, 1],
		translateX: [0, 4, 0],
		translateY: [0, 4, 0],
		originX: 0,
		originY: 0,
		transition: {
			duration: 0.5,
			ease: "easeInOut",
		},
	},
};

export const ArrowUpLeftIcon = forwardRef<SVGSVGElement, LucideProps>(function ArrowUpLeftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-arrow-up-left ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g animate={controls} variants={ARROW_VARIANTS}>
				<path d="M7 7H17" />
				<path d="M7 7V17" />
				<path d="M17 17L7 7" />
			</M.g>
		</svg>
	);
});
