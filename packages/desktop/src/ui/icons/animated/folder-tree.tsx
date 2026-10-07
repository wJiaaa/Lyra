// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/folder-tree.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DURATION = 0.35;

const BRANCH_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		pathOffset: [1, 0],
	},
};

const PANEL_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
	},
};

const CALCULATE_DELAY = (index: number) => index * DURATION + 0.1;

export const FolderTreeIcon = forwardRef<SVGSVGElement, LucideProps>(function FolderTreeIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-folder-tree ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
				initial="normal"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(0),
					opacity: { delay: CALCULATE_DELAY(0) },
				}}
				variants={PANEL_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
				initial="normal"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(2),
					opacity: { delay: CALCULATE_DELAY(2) },
				}}
				variants={PANEL_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M3 5a2 2 0 0 0 2 2h3"
				initial="normal"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(1),
					opacity: { delay: CALCULATE_DELAY(1) },
				}}
				variants={BRANCH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M3 3v13a2 2 0 0 0 2 2h3"
				initial="normal"
				transition={{
					duration: DURATION,
					delay: CALCULATE_DELAY(3),
					opacity: { delay: CALCULATE_DELAY(3) },
				}}
				variants={BRANCH_VARIANTS}
			/>
		</svg>
	);
});
