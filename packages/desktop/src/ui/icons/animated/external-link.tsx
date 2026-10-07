// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/external-link.tsx
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
		scale: [1, 0.92, 1],
		translateX: [0, 2, 0],
		translateY: [0, -2, 0],
		originX: 1,
		originY: 0,
		transition: {
			duration: 0.5,
			ease: "easeInOut",
		},
	},
};

export const ExternalLinkIcon = forwardRef<SVGSVGElement, LucideProps>(function ExternalLinkIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-external-link ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
			<M.g animate={controls} variants={ARROW_VARIANTS}>
				<path d="M15 3h6v6" />
				<path d="M10 14 21 3" />
			</M.g>
		</svg>
	);
});
