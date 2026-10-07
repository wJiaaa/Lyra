// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/history.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ARROW_TRANSITION: Transition = {
	type: "spring",
	stiffness: 250,
	damping: 25,
};

const ARROW_VARIANTS: Variants = {
	normal: {
		rotate: "0deg",
	},
	animate: {
		rotate: "-50deg",
	},
};

const HAND_TRANSITION: Transition = {
	duration: 0.6,
	ease: [0.4, 0, 0.2, 1],
};

const HAND_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		originX: "0%",
		originY: "100%",
	},
	animate: {
		rotate: -360,
		originX: "0%",
		originY: "100%",
	},
};

const MINUTE_HAND_TRANSITION: Transition = {
	duration: 0.5,
	ease: "easeInOut",
};

const MINUTE_HAND_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		originX: "0%",
		originY: "0%",
	},
	animate: {
		rotate: -45,
		originX: "0%",
		originY: "0%",
	},
};

export const RotateCcwClockIcon = forwardRef<SVGSVGElement, LucideProps>(function RotateCcwClockIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-rotate-ccw-clock ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				transition={ARROW_TRANSITION}
				variants={ARROW_VARIANTS}
			>
				<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
				<path d="M3 3v5h5" />
			</M.g>
			<M.line
				animate={controls}
				initial="normal"
				transition={HAND_TRANSITION}
				variants={HAND_VARIANTS}
				x1="12"
				x2="12"
				y1="12"
				y2="7"
			/>
			<M.line
				animate={controls}
				initial="normal"
				transition={MINUTE_HAND_TRANSITION}
				variants={MINUTE_HAND_VARIANTS}
				x1="12"
				x2="16"
				y1="12"
				y2="14"
			/>
		</svg>
	);
});
