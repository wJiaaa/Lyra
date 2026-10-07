// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/user.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。
// 上游画的是旧版 lucide，形状已换成 lucide 现在的画法，动画仍挂在对应的部件上。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANT: Variants = {
	normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		pathOffset: [1, 0],
	},
};

const CIRCLE_VARIANT: Variants = {
	normal: {
		pathLength: 1,
		pathOffset: 0,
		scale: 1,
	},
	animate: {
		pathLength: [0, 1],
		pathOffset: [1, 0],
		scale: [0.5, 1],
	},
};

export const UserIcon = forwardRef<SVGSVGElement, LucideProps>(function UserIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-user ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle
				animate={controls}
				cx="12"
				cy="7"
				r="4"
				variants={CIRCLE_VARIANT}
			/>

			<M.path
				animate={controls}
				d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"
				transition={{
					delay: 0.2,
					duration: 0.4,
				}}
				variants={PATH_VARIANT}
			/>
		</svg>
	);
});
