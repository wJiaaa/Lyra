// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/link-2.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LEFT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: {
		x: [0, -0.7, 0.3, 0],
		transition: {
			duration: 0.6,
			times: [0, 0.4, 0.75, 1],
			ease: "easeInOut",
		},
	},
};

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: {
		x: [0, 0.7, -0.3, 0],
		transition: {
			duration: 0.6,
			times: [0, 0.4, 0.75, 1],
			ease: "easeInOut",
		},
	},
};

export const Link2Icon = forwardRef<SVGSVGElement, LucideProps>(function Link2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-link-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g animate={controls} variants={LEFT_VARIANTS}>
				<path d="M9 17H7A5 5 0 0 1 7 7h2" />
				<line x1="8" x2="12" y1="12" y2="12" />
			</M.g>
			<M.g animate={controls} variants={RIGHT_VARIANTS}>
				<path d="M15 7h2a5 5 0 1 1 0 10h-2" />
				<line x1="16" x2="12" y1="12" y2="12" />
			</M.g>
		</svg>
	);
});
