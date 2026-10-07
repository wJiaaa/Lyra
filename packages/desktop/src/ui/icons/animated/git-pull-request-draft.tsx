// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 git-pull-request-draft，悬停时草稿那两段虚线依次闪一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const BLINK_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: (i: number) => ({ opacity: [1, 0.2, 1], transition: { duration: 0.4, delay: i * 0.12, ease: "easeInOut" } }),
};

export const GitPullRequestDraftIcon = forwardRef<SVGSVGElement, LucideProps>(function GitPullRequestDraftIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-pull-request-draft ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="18" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<M.path
				animate={controls}
				custom={1}
				variants={BLINK_VARIANTS}
				d="M18 6V5"
			/>
			<M.path
				animate={controls}
				custom={0}
				variants={BLINK_VARIANTS}
				d="M18 11v-1"
			/>
			<line x1="6" x2="6" y1="9" y2="21" />
		</svg>
	);
});
