// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/git-commit-horizontal.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
	},
	animate: (custom: number) => ({
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			delay: 0.15 * custom,
			opacity: { delay: 0.1 * custom },
		},
	}),
};

export const GitCommitHorizontalIcon = forwardRef<SVGSVGElement, LucideProps>(function GitCommitHorizontalIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-commit-horizontal ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				custom={1}
				cx="12"
				cy="12"
				r="3"
				variants={VARIANTS}
			/>
			<M.line
				animate={controls}
				custom={0}
				variants={VARIANTS}
				x1="3"
				x2="9"
				y1="12"
				y2="12"
			/>
			<M.line
				animate={controls}
				custom={2}
				variants={VARIANTS}
				x1="15"
				x2="21"
				y1="12"
				y2="12"
			/>
		</svg>
	);
});
