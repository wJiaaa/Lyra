// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 circle-slash，悬停时斜线重新划一道。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: { pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const CircleSlashIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleSlashIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-slash ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.line
				animate={controls}
				variants={DRAW_VARIANTS}
				x1="9"
				x2="15"
				y1="15"
				y2="9"
			/>
		</svg>
	);
});
