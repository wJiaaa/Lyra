// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/sparkles.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SPARKLE_VARIANTS: Variants = {
	initial: {
		y: 0,
		fill: "none",
	},
	hover: {
		y: [0, -1, 0, 0],
		fill: "currentColor",
		transition: {
			duration: 1,
			bounce: 0.3,
		},
	},
};

const STAR_VARIANTS: Variants = {
	initial: {
		opacity: 1,
		x: 0,
		y: 0,
	},
	blink: () => ({
		opacity: [0, 1, 0, 0, 0, 0, 1],
		transition: {
			duration: 2,
			type: "spring",
			stiffness: 70,
			damping: 10,
			mass: 0.4,
		},
	}),
};

export const SparklesIcon = forwardRef<SVGSVGElement, LucideProps>(function SparklesIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const starControls = useAnimation();
	const sparkleControls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => {
			void sparkleControls.start("hover");
			void starControls.start("blink", { delay: 1 });
		},
		() => {
			void sparkleControls.start("initial");
			void starControls.start("initial");
		},
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
			className={`lucide lucide-sparkles ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={sparkleControls}
				d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
				variants={SPARKLE_VARIANTS}
			/>
			<M.path
				animate={starControls}
				d="M20 2v4"
				variants={STAR_VARIANTS}
			/>
			<M.path
				animate={starControls}
				d="M22 4h-4"
				variants={STAR_VARIANTS}
			/>
			<M.circle
				animate={starControls}
				cx="4"
				cy="20"
				r="2"
				variants={STAR_VARIANTS}
			/>
		</svg>
	);
});
