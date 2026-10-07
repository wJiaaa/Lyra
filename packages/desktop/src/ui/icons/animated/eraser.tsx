// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 eraser，悬停时来回擦两下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const RUB_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 1.5, -1, 0], transition: { duration: 0.5, ease: "easeInOut" } },
};

export const EraserIcon = forwardRef<SVGSVGElement, LucideProps>(function EraserIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-eraser ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={RUB_VARIANTS}
			>
				<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" />
				<path d="m5.082 11.09 8.828 8.828" />
			</M.g>
		</svg>
	);
});
