// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 cable，悬停时两头的插头各往外拔一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TOP_PLUG_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const BOTTOM_PLUG_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const CableIcon = forwardRef<SVGSVGElement, LucideProps>(function CableIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-cable ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={BOTTOM_PLUG_VARIANTS}
			>
				<path d="M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z" />
				<path d="M17 21v-2" />
				<path d="M21 21v-2" />
			</M.g>
			<path d="M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10" />
			<M.g
				animate={controls}
				variants={TOP_PLUG_VARIANTS}
			>
				<path d="M3 5V3" />
				<path d="M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z" />
				<path d="M7 5V3" />
			</M.g>
		</svg>
	);
});
