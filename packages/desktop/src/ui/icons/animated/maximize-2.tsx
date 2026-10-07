// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/maximize-2.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Transition } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	type: "spring",
	stiffness: 250,
	damping: 25,
};

export const Maximize2Icon = forwardRef<SVGSVGElement, LucideProps>(function Maximize2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-maximize-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M9 21H3v-6M3 21l7-7"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { translateX: "0%", translateY: "0%" },
					animate: { translateX: "-2px", translateY: "2px" },
				}}
			/>
			<M.path
				animate={controls}
				d="M15 3h6v6M21 3l-7 7"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { translateX: "0%", translateY: "0%" },
					animate: { translateX: "2px", translateY: "-2px" },
				}}
			/>
		</svg>
	);
});
