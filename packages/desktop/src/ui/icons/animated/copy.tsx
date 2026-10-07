// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/copy.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	type: "spring",
	stiffness: 160,
	damping: 17,
	mass: 1,
};

export const CopyIcon = forwardRef<SVGSVGElement, LucideProps>(function CopyIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-copy ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				height="14"
				rx="2"
				ry="2"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { translateY: 0, translateX: 0 },
					animate: { translateY: -3, translateX: -3 },
				}}
				width="14"
				x="8"
				y="8"
			/>
			<M.path
				animate={controls}
				d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { x: 0, y: 0 },
					animate: { x: 3, y: 3 },
				}}
			/>
		</svg>
	);
});
