// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 zoom-in，悬停时镜片放大一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LENS_VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: [1, 1.15, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ZoomInIcon = forwardRef<SVGSVGElement, LucideProps>(function ZoomInIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-zoom-in ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={LENS_VARIANTS}
			>
				<circle cx="11" cy="11" r="8" />
				<line x1="11" x2="11" y1="8" y2="14" />
				<line x1="8" x2="14" y1="11" y2="11" />
			</M.g>
			<line x1="21" x2="16.65" y1="21" y2="16.65" />
		</svg>
	);
});
