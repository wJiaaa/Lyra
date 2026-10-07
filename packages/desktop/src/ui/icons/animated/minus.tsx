// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 minus，悬停时横线收短再弹回。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LINE_VARIANTS: Variants = {
	normal: { scaleX: 1 },
	animate: { scaleX: [1, 0.5, 1.15, 1], transition: { duration: 0.45, ease: "easeInOut" } },
};

export const MinusIcon = forwardRef<SVGSVGElement, LucideProps>(function MinusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-minus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={LINE_VARIANTS}
				d="M5 12h14"
			/>
		</svg>
	);
});
