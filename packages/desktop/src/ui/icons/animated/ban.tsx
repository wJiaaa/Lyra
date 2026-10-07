// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/ban.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const CIRCLE_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		transition: {
			duration: 0.3,
			opacity: { duration: 0.1 },
		},
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
		transition: {
			duration: 0.4,
			opacity: { duration: 0.1 },
		},
	},
};

const LINE_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		transition: {
			duration: 0.3,
			opacity: { duration: 0.1 },
		},
	},
	slash: () => ({
		opacity: [0, 1],
		pathLength: [0, 1],
		transition: {
			duration: 0.4,
			opacity: { duration: 0.1 },
		},
	}),
};

export const BanIcon = forwardRef<SVGSVGElement, LucideProps>(function BanIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => {
			void controls.start("animate");
			void controls.start("slash", { delay: 0.5 });
		},
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
			className={`lucide lucide-ban ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				cx="12"
				cy="12"
				initial="normal"
				r="10"
				variants={CIRCLE_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="m4.9 4.9 14.2 14.2"
				initial="normal"
				variants={LINE_VARIANTS}
			/>
		</svg>
	);
});
