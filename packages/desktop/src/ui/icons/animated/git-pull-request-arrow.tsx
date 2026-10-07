// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 git-pull-request-arrow，悬停时箭头往左推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const GitPullRequestArrowIcon = forwardRef<SVGSVGElement, LucideProps>(function GitPullRequestArrowIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-pull-request-arrow ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="5" cy="6" r="3" />
			<path d="M5 9v12" />
			<circle cx="19" cy="18" r="3" />
			<M.path
				animate={controls}
				variants={NUDGE_VARIANTS}
				d="m15 9-3-3 3-3"
			/>
			<path d="M12 6h5a2 2 0 0 1 2 2v7" />
		</svg>
	);
});
