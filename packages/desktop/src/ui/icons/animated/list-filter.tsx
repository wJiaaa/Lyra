// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 list-filter，悬停时三道线从上到下依次收一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LINE_VARIANTS: Variants = {
	normal: { scaleX: 1 },
	animate: (i: number) => ({ scaleX: [1, 0.6, 1], transition: { duration: 0.35, delay: i * 0.08, ease: "easeInOut" } }),
};

export const ListFilterIcon = forwardRef<SVGSVGElement, LucideProps>(function ListFilterIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-list-filter ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={0}
				variants={LINE_VARIANTS}
				d="M2 5h20"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={LINE_VARIANTS}
				d="M6 12h12"
			/>
			<M.path
				animate={controls}
				custom={2}
				variants={LINE_VARIANTS}
				d="M9 19h6"
			/>
		</svg>
	);
});
