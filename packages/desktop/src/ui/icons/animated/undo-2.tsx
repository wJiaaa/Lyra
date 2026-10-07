// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 undo-2，悬停时箭头往回退一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ARROW_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -2.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const Undo2Icon = forwardRef<SVGSVGElement, LucideProps>(function Undo2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-undo-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={ARROW_VARIANTS}
			>
				<path d="M9 14 4 9l5-5" />
				<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
			</M.g>
		</svg>
	);
});
