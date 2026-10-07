// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/sliders-horizontal.tsx
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
	damping: 12,
	mass: 0.4,
};

export const SlidersHorizontalIcon = forwardRef<SVGSVGElement, LucideProps>(function SlidersHorizontalIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-sliders-horizontal ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.line
				animate={controls}
				initial={false}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x2: 14,
					},
					animate: {
						x2: 10,
					},
				}}
				x1="21"
				x2="14"
				y1="5"
				y2="5"
			/>
			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 10,
					},
					animate: {
						x1: 5,
					},
				}}
				x1="10"
				x2="3"
				y1="5"
				y2="5"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x2: 12,
					},
					animate: {
						x2: 18,
					},
				}}
				x1="21"
				x2="12"
				y1="12"
				y2="12"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 8,
					},
					animate: {
						x1: 13,
					},
				}}
				x1="8"
				x2="3"
				y1="12"
				y2="12"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x2: 12,
					},
					animate: {
						x2: 4,
					},
				}}
				x1="3"
				x2="12"
				y1="19"
				y2="19"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 16,
					},
					animate: {
						x1: 8,
					},
				}}
				x1="16"
				x2="21"
				y1="19"
				y2="19"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 14,
						x2: 14,
					},
					animate: {
						x1: 9,
						x2: 9,
					},
				}}
				x1="14"
				x2="14"
				y1="3"
				y2="7"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 8,
						x2: 8,
					},
					animate: {
						x1: 14,
						x2: 14,
					},
				}}
				x1="8"
				x2="8"
				y1="10"
				y2="14"
			/>

			<M.line
				animate={controls}
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: {
						x1: 16,
						x2: 16,
					},
					animate: {
						x1: 8,
						x2: 8,
					},
				}}
				x1="16"
				x2="16"
				y1="17"
				y2="21"
			/>
		</svg>
	);
});
