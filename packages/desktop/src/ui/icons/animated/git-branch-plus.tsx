// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 git-branch-plus，悬停时加号转半圈，和 plus 同一套弹簧。
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

const PLUS_TRANSITION: Transition = { type: "spring", stiffness: 100, damping: 15 };

export const GitBranchPlusIcon = forwardRef<SVGSVGElement, LucideProps>(function GitBranchPlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-branch-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M6 3v12" />
			<path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
			<path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
			<path d="M15 6a9 9 0 0 0-9 9" />
			<M.g
				animate={controls}
				variants={PLUS_VARIANTS}
				transition={PLUS_TRANSITION}
			>
				<path d="M18 15v6" />
				<path d="M21 18h-6" />
			</M.g>
		</svg>
	);
});
