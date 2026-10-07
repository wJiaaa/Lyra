// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 copy-minus，悬停时减号收短再弹回，和 minus 同一套。
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

export const CopyMinusIcon = forwardRef<SVGSVGElement, LucideProps>(function CopyMinusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-copy-minus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.line
				animate={controls}
				variants={LINE_VARIANTS}
				x1="12"
				x2="18"
				y1="15"
				y2="15"
			/>
			<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</svg>
	);
});
