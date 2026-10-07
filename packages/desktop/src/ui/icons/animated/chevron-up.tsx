// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/chevron-up.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	times: [0, 0.4, 1],
	duration: 0.5,
};

export const ChevronUpIcon = forwardRef<SVGSVGElement, LucideProps>(function ChevronUpIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-chevron-up ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="m18 15-6-6-6 6"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { y: 0 },
					animate: { y: [0, -2, 0] },
				}}
			/>
		</svg>
	);
});
