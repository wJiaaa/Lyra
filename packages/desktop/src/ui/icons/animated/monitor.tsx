// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 monitor，悬停时屏幕鼓一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const POP_VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: [1, 1.06, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const MonitorIcon = forwardRef<SVGSVGElement, LucideProps>(function MonitorIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-monitor ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				variants={POP_VARIANTS}
				width="20"
				height="14"
				x="2"
				y="3"
				rx="2"
			/>
			<line x1="8" x2="16" y1="21" y2="21" />
			<line x1="12" x2="12" y1="17" y2="21" />
		</svg>
	);
});
