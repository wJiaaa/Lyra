// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 pencil-line，悬停时笔尖来回写一下，底下那道线跟着画出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PEN_VARIANTS: Variants = {
	normal: { rotate: 0, x: 0, y: 0 },
	animate: { rotate: [-0.5, 0.5, -0.5], x: [0, -1, 1.5, 0], y: [0, 1.5, -1, 0], transition: { duration: 0.5 } },
};

const LINE_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: { pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.4, delay: 0.1 } },
};

export const PencilLineIcon = forwardRef<SVGSVGElement, LucideProps>(function PencilLineIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-pencil-line ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={LINE_VARIANTS}
				d="M13 21h8"
			/>
			<M.g
				animate={controls}
				variants={PEN_VARIANTS}
			>
				<path d="m15 5 4 4" />
				<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
			</M.g>
		</svg>
	);
});
