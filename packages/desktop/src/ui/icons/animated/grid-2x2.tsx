// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 grid-2x2，悬停时中间的十字转四分之一圈。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const CROSS_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: 90 },
};

const SPRING: Transition = { type: "spring", stiffness: 100, damping: 15 };

export const Grid2x2Icon = forwardRef<SVGSVGElement, LucideProps>(function Grid2x2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-grid-2x2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={CROSS_VARIANTS}
				transition={SPRING}
			>
				<path d="M12 3v18" />
				<path d="M3 12h18" />
			</M.g>
			<rect x="3" y="3" width="18" height="18" rx="2" />
		</svg>
	);
});
