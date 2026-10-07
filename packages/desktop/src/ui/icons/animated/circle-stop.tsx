// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 circle-stop，悬停时中间的方块收一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const POP_VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: [1, 0.7, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const CircleStopIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleStopIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-stop ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.rect
				animate={controls}
				variants={POP_VARIANTS}
				x="9"
				y="9"
				width="6"
				height="6"
				rx="1"
			/>
		</svg>
	);
});
