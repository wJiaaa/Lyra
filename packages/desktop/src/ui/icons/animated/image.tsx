// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 image，悬停时太阳升一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SUN_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ImageIcon = forwardRef<SVGSVGElement, LucideProps>(function ImageIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-image ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
			<M.circle
				animate={controls}
				variants={SUN_VARIANTS}
				cx="9"
				cy="9"
				r="2"
			/>
			<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
		</svg>
	);
});
