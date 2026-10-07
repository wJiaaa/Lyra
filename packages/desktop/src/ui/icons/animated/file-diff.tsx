// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-diff，悬停时加号转半圈，减号收一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PLUS_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: 180 },
};

const SPRING: Transition = { type: "spring", stiffness: 100, damping: 15 };

const MINUS_VARIANTS: Variants = {
	normal: { scaleX: 1 },
	animate: { scaleX: [1, 0.5, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const FileDiffIcon = forwardRef<SVGSVGElement, LucideProps>(function FileDiffIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-diff ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
			<M.g
				animate={controls}
				variants={PLUS_VARIANTS}
				transition={SPRING}
			>
				<path d="M9 10h6" />
				<path d="M12 13V7" />
			</M.g>
			<M.path
				animate={controls}
				variants={MINUS_VARIANTS}
				d="M9 17h6"
			/>
		</svg>
	);
});
