// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/folder-git-2.tsx
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

export const FolderGit2Icon = forwardRef<SVGSVGElement, LucideProps>(function FolderGit2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-folder-git-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
			<M.circle
				animate={controls}
				cx="13"
				cy="12"
				r="2"
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
			<M.path
				animate={controls}
				d="M18 19c-2.8 0-5-2.2-5-5v8"
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
			<M.circle
				animate={controls}
				cx="20"
				cy="19"
				r="2"
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
		</svg>
	);
});
