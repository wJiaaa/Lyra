// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 tag，悬停时绕着孔晃两下。
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

export const TagIcon = forwardRef<SVGSVGElement, LucideProps>(function TagIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-tag ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={WIGGLE_VARIANTS}
				style={{ originX: 0.275, originY: 0.275 }}
			>
				<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
				<circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
			</M.g>
		</svg>
	);
});
