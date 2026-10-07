// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/users.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: {
		translateX: 0,
		transition: {
			type: "spring",
			stiffness: 200,
			damping: 13,
		},
	},
	animate: {
		translateX: [-6, 0],
		transition: {
			delay: 0.1,
			type: "spring",
			stiffness: 200,
			damping: 13,
		},
	},
};

export const UsersIcon = forwardRef<SVGSVGElement, LucideProps>(function UsersIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-users ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
			<circle cx="9" cy="7" r="4" />
			<M.path
				animate={controls}
				d="M22 21v-2a4 4 0 0 0-3-3.87"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M16 3.13a4 4 0 0 1 0 7.75"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
