// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/wrench.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ICON_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		transition: { duration: 0.25, ease: "easeOut" },
	},
	animate: {
		rotate: [0, 12, -14, 4, 0],
		transition: {
			duration: 1.05,
			times: [0, 0.42, 0.68, 0.88, 1],
			ease: ["easeInOut", "easeInOut", "easeOut", "easeOut"],
		},
	},
};

export const WrenchIcon = forwardRef<SVGSVGElement, LucideProps>(function WrenchIcon({ className, style, size = 24, strokeWidth = 2, ...props }, ref) {
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
			style={{ transformOrigin: "90% 10%", transformBox: "fill-box", ...style }}
			variants={ICON_VARIANTS}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-wrench ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
		</M.svg>
	);
});
