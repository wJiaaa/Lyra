// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/server.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TOP_RECT_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: {
		y: [0, 12, 12, 0],
		transition: {
			duration: 0.9,
			ease: "easeInOut",
			repeat: 1,
			times: [0, 0.35, 0.65, 1],
		},
	},
};

const BOTTOM_RECT_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: {
		y: [0, -12, -12, 0],
		transition: {
			duration: 0.9,
			ease: "easeInOut",
			repeat: 1,
			times: [0, 0.35, 0.65, 1],
		},
	},
};

export const ServerIcon = forwardRef<SVGSVGElement, LucideProps>(function ServerIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-server overflow-visible ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				initial="normal"
				variants={TOP_RECT_VARIANTS}
			>
				<rect height="8" rx="2" ry="2" width="20" x="2" y="2" />
				<line x1="6" x2="6.01" y1="6" y2="6" />
			</M.g>
			<M.g
				animate={controls}
				initial="normal"
				variants={BOTTOM_RECT_VARIANTS}
			>
				<rect height="8" rx="2" ry="2" width="20" x="2" y="14" />
				<line x1="6" x2="6.01" y1="18" y2="18" />
			</M.g>
		</svg>
	);
});
