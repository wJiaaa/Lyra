// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-plus-corner，悬停时加号转半圈，和 plus 同一套弹簧。
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

export const FilePlusCornerIcon = forwardRef<SVGSVGElement, LucideProps>(function FilePlusCornerIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-plus-corner ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<M.g
				animate={controls}
				variants={PLUS_VARIANTS}
				transition={SPRING}
			>
				<path d="M14 19h6" />
				<path d="M17 16v6" />
			</M.g>
		</svg>
	);
});
