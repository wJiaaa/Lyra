// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 globe，悬停时经线收窄再展开，像地球转了半圈。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const MERIDIAN_VARIANTS: Variants = {
	normal: { scaleX: 1 },
	animate: { scaleX: [1, 0.15, 1], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const GlobeIcon = forwardRef<SVGSVGElement, LucideProps>(function GlobeIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-globe ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.path
				animate={controls}
				variants={MERIDIAN_VARIANTS}
				d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"
			/>
			<path d="M2 12h20" />
		</svg>
	);
});
