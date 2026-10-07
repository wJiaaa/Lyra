// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/layout-grid.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const RECT_1_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 11, 11, 0],
		translateY: [0, 0, 0, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] },
	},
};

const RECT_2_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 0, 0, 0],
		translateY: [0, 11, 11, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] },
	},
};

const RECT_3_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, -11, -11, 0],
		translateY: [0, 0, 0, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] },
	},
};

const RECT_4_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 0, 0, 0],
		translateY: [0, -11, -11, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] },
	},
};

export const LayoutGridIcon = forwardRef<SVGSVGElement, LucideProps>(function LayoutGridIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-layout-grid ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_1_VARIANTS}
				width="7"
				x="3"
				y="3"
			/>
			<M.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_2_VARIANTS}
				width="7"
				x="14"
				y="3"
			/>
			<M.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_3_VARIANTS}
				width="7"
				x="14"
				y="14"
			/>
			<M.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_4_VARIANTS}
				width="7"
				x="3"
				y="14"
			/>
		</svg>
	);
});
