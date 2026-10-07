// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/git-pull-request.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DURATION = 0.3;

const CALCULATE_DELAY = (i: number) => {
	if (i === 0) return 0.1;

	return i * DURATION + 0.1;
};

export const GitPullRequestIcon = forwardRef<SVGSVGElement, LucideProps>(function GitPullRequestIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-pull-request ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				cx="18"
				cy="18"
				r="3"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(0),
					opacity: { delay: CALCULATE_DELAY(0) },
				}}
				variants={{
					normal: { pathLength: 1, opacity: 1, transition: { delay: 0 } },
					animate: {
						pathLength: [0, 1],
						opacity: [0, 1],
					},
				}}
			/>
			<M.circle
				animate={controls}
				cx="6"
				cy="6"
				r="3"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(2),
					opacity: { delay: CALCULATE_DELAY(2) },
				}}
				variants={{
					normal: { pathLength: 1, opacity: 1, transition: { delay: 0 } },
					animate: {
						pathLength: [0, 1],
						opacity: [0, 1],
					},
				}}
			/>
			<M.path
				animate={controls}
				d="M13 6h3a2 2 0 0 1 2 2v7"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(1),
					opacity: { delay: CALCULATE_DELAY(1) },
				}}
				variants={{
					normal: {
						pathLength: 1,
						pathOffset: 0,
						opacity: 1,
						transition: { delay: 0 },
					},
					animate: {
						pathLength: [0, 1],
						opacity: [0, 1],
						pathOffset: [1, 0],
					},
				}}
			/>
			<M.line
				animate={controls}
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(3),
					opacity: { delay: CALCULATE_DELAY(3) },
				}}
				variants={{
					normal: { opacity: 1, pathLength: 1, transition: { delay: 0 } },
					animate: {
						opacity: [0, 1],
						pathLength: [0, 1],
					},
				}}
				x1="6"
				x2="6"
				y1="9"
				y2="21"
			/>
		</svg>
	);
});
