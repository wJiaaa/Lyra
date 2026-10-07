// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/layers.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Transition } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	type: "spring",
	stiffness: 100,
	damping: 14,
	mass: 1,
};

export const LayersIcon = forwardRef<SVGSVGElement, LucideProps>(function LayersIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("firstState").then(() => controls.start("secondState")),
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
			className={`lucide lucide-layers ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
			<M.path
				animate={controls}
				d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { y: 0 },
					firstState: { y: -9 },
					secondState: { y: 0 },
				}}
			/>
			<M.path
				animate={controls}
				d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { y: 0 },
					firstState: { y: -5 },
					secondState: { y: 0 },
				}}
			/>
		</svg>
	);
});
