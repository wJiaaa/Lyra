// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 circle-x，悬停时叉的两笔依次画出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (i: number) => ({ pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.3, delay: i * 0.15, ease: "easeInOut" } }),
};

export const CircleXIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleXIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-x ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.path
				animate={controls}
				custom={1}
				variants={DRAW_VARIANTS}
				d="m15 9-6 6"
			/>
			<M.path
				animate={controls}
				custom={0}
				variants={DRAW_VARIANTS}
				d="m9 9 6 6"
			/>
		</svg>
	);
});
