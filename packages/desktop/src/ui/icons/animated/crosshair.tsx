// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 crosshair，悬停时四根刻度线转四分之一圈。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TICKS_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: 90 },
};

const SPRING: Transition = { type: "spring", stiffness: 100, damping: 15 };

export const CrosshairIcon = forwardRef<SVGSVGElement, LucideProps>(function CrosshairIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-crosshair ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.g
				animate={controls}
				variants={TICKS_VARIANTS}
				transition={SPRING}
			>
				<line x1="22" x2="18" y1="12" y2="12" />
				<line x1="6" x2="2" y1="12" y2="12" />
				<line x1="12" x2="12" y1="6" y2="2" />
				<line x1="12" x2="12" y1="22" y2="18" />
			</M.g>
		</svg>
	);
});
