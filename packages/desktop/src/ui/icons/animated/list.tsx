// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 list，悬停时三行从上到下依次往右推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: (i: number) => ({ x: [0, 1.5, 0], transition: { duration: 0.35, delay: i * 0.08, ease: "easeInOut" } }),
};

export const ListIcon = forwardRef<SVGSVGElement, LucideProps>(function ListIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-list ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				custom={0}
				variants={NUDGE_VARIANTS}
			>
				<path d="M3 5h.01" />
				<path d="M8 5h13" />
			</M.g>
			<M.g
				animate={controls}
				custom={1}
				variants={NUDGE_VARIANTS}
			>
				<path d="M3 12h.01" />
				<path d="M8 12h13" />
			</M.g>
			<M.g
				animate={controls}
				custom={2}
				variants={NUDGE_VARIANTS}
			>
				<path d="M3 19h.01" />
				<path d="M8 19h13" />
			</M.g>
		</svg>
	);
});
