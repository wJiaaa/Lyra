// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 ellipsis，悬停时三个点从左到右依次跳一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DOT_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: (i: number) => ({ y: [0, -2.5, 0], transition: { duration: 0.35, delay: i * 0.08, ease: "easeInOut" } }),
};

export const EllipsisIcon = forwardRef<SVGSVGElement, LucideProps>(function EllipsisIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-ellipsis ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				custom={0}
				variants={DOT_VARIANTS}
				cx="5"
				cy="12"
				r="1"
			/>
			<M.circle
				animate={controls}
				custom={1}
				variants={DOT_VARIANTS}
				cx="12"
				cy="12"
				r="1"
			/>
			<M.circle
				animate={controls}
				custom={2}
				variants={DOT_VARIANTS}
				cx="19"
				cy="12"
				r="1"
			/>
		</svg>
	);
});
