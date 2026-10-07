// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 braces，悬停时两边的花括号往外撑一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LEFT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const BracesIcon = forwardRef<SVGSVGElement, LucideProps>(function BracesIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-braces ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={LEFT_VARIANTS}
				d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"
			/>
			<M.path
				animate={controls}
				variants={RIGHT_VARIANTS}
				d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"
			/>
		</svg>
	);
});
