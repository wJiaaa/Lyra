// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 lightbulb，悬停时灯泡闪两下，像刚亮起来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const GLOW_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: { opacity: [1, 0.3, 1, 0.3, 1], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const LightbulbIcon = forwardRef<SVGSVGElement, LucideProps>(function LightbulbIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-lightbulb ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={GLOW_VARIANTS}
				d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"
			/>
			<path d="M9 18h6" />
			<path d="M10 22h4" />
		</svg>
	);
});
