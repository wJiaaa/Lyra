// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 list-ordered，悬停时三行字从上到下依次写出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (i: number) => ({ pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.3, delay: i * 0.1, ease: "easeInOut" } }),
};

export const ListOrderedIcon = forwardRef<SVGSVGElement, LucideProps>(function ListOrderedIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-list-ordered ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={0}
				variants={DRAW_VARIANTS}
				d="M11 5h10"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={DRAW_VARIANTS}
				d="M11 12h10"
			/>
			<M.path
				animate={controls}
				custom={2}
				variants={DRAW_VARIANTS}
				d="M11 19h10"
			/>
			<path d="M4 4h1v5" />
			<path d="M4 9h2" />
			<path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />
		</svg>
	);
});
