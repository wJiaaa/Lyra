// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 chevrons-down，悬停时两道折线依次往下点一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: (i: number) => ({ y: [0, 2, 0], transition: { duration: 0.4, delay: i * 0.1, ease: "easeInOut" } }),
};

export const ChevronsDownIcon = forwardRef<SVGSVGElement, LucideProps>(function ChevronsDownIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-chevrons-down ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={0}
				variants={NUDGE_VARIANTS}
				d="m7 6 5 5 5-5"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={NUDGE_VARIANTS}
				d="m7 13 5 5 5-5"
			/>
		</svg>
	);
});
