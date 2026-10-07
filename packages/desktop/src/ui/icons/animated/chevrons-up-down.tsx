// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/chevrons-up-down.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

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

export const ChevronsUpDownIcon = forwardRef<SVGSVGElement, LucideProps>(function ChevronsUpDownIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-chevrons-up-down ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="m7 15 5 5 5-5"
				initial="normal"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { translateY: "0%" },
					animate: { translateY: "2px" },
				}}
			/>
			<M.path
				animate={controls}
				d="m7 9 5-5 5 5"
				initial="normal"
				transition={DEFAULT_TRANSITION}
				variants={{
					normal: { translateY: "0%" },
					animate: { translateY: "-2px" },
				}}
			/>
		</svg>
	);
});
