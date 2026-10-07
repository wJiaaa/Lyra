// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 scan，悬停时四个角往外扩一下，像在对焦。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TOP_LEFT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, -1.5, 0], y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const TOP_RIGHT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, 1.5, 0], y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const BOTTOM_RIGHT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, 1.5, 0], y: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const BOTTOM_LEFT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, -1.5, 0], y: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ScanIcon = forwardRef<SVGSVGElement, LucideProps>(function ScanIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-scan ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={TOP_LEFT_VARIANTS}
				d="M3 7V5a2 2 0 0 1 2-2h2"
			/>
			<M.path
				animate={controls}
				variants={TOP_RIGHT_VARIANTS}
				d="M17 3h2a2 2 0 0 1 2 2v2"
			/>
			<M.path
				animate={controls}
				variants={BOTTOM_RIGHT_VARIANTS}
				d="M21 17v2a2 2 0 0 1-2 2h-2"
			/>
			<M.path
				animate={controls}
				variants={BOTTOM_LEFT_VARIANTS}
				d="M7 21H5a2 2 0 0 1-2-2v-2"
			/>
		</svg>
	);
});
