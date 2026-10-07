// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 panel-left，悬停时侧栏的分隔线往左收一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DIVIDER_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -2.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const PanelLeftIcon = forwardRef<SVGSVGElement, LucideProps>(function PanelLeftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-panel-left ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<M.path
				animate={controls}
				variants={DIVIDER_VARIANTS}
				d="M9 3v18"
			/>
		</svg>
	);
});
