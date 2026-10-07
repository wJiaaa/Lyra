// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/blocks.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: { translateX: -4, translateY: 4 },
};

export const BlocksIcon = forwardRef<SVGSVGElement, LucideProps>(function BlocksIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-blocks ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
			<M.rect
				animate={controls}
				x="14"
				y="2"
				width="8"
				height="8"
				rx="1"
				variants={VARIANTS}
			/>
		</svg>
	);
});
