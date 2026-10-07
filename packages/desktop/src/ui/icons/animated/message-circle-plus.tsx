// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/message-circle-plus.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PLUS_VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
		transition: {
			duration: 0.3,
		},
	},
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			pathLength: { duration: 0.4, ease: "easeInOut" },
			opacity: { duration: 0.4, ease: "easeInOut" },
		},
	},
};

const PLUS_HORIZONTAL_VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
		transition: {
			duration: 0.3,
		},
	},
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			pathLength: { duration: 0.4, ease: "easeInOut", delay: 0.2 },
			opacity: { duration: 0.4, ease: "easeInOut", delay: 0.2 },
		},
	},
};

export const MessageCirclePlusIcon = forwardRef<SVGSVGElement, LucideProps>(function MessageCirclePlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-message-circle-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
			<M.path
				animate={controls}
				d="M12 8v8"
				initial="normal"
				variants={PLUS_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M8 12h8"
				initial="normal"
				variants={PLUS_HORIZONTAL_VARIANTS}
			/>
		</svg>
	);
});
