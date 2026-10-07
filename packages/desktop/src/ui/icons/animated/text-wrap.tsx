// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 text-wrap，悬停时换行的箭头往回勾一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const TextWrapIcon = forwardRef<SVGSVGElement, LucideProps>(function TextWrapIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-text-wrap ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={NUDGE_VARIANTS}
				d="m16 16-3 3 3 3"
			/>
			<path d="M3 12h14.5a1 1 0 0 1 0 7H13" />
			<path d="M3 19h6" />
			<path d="M3 5h18" />
		</svg>
	);
});
