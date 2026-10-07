// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 anchor，悬停时绕顶上的环晃两下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const WIGGLE_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -10, 7, -3.5, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const AnchorIcon = forwardRef<SVGSVGElement, LucideProps>(function AnchorIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-anchor ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={WIGGLE_VARIANTS}
				style={{ originX: 0.5, originY: 0 }}
			>
				<path d="M12 6v16" />
				<path d="m19 13 2-1a9 9 0 0 1-18 0l2 1" />
				<path d="M9 11h6" />
				<circle cx="12" cy="4" r="2" />
			</M.g>
		</svg>
	);
});
