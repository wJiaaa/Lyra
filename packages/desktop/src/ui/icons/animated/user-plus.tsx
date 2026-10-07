// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/user-plus.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PLUS_VARIANTS: Variants = {
	normal: {
		scale: 1,
		rotate: 0,
		opacity: 1,
		transition: {
			duration: 0.3,
			ease: "easeOut",
		},
	},
	animate: {
		scale: [0, 1.15, 1],
		rotate: [-90, 0, 0],
		opacity: [0, 1, 1],
		transition: {
			delay: 0.25,
			duration: 0.45,
			ease: "easeOut",
			times: [0, 0.7, 1],
		},
	},
};

export const UserPlusIcon = forwardRef<SVGSVGElement, LucideProps>(function UserPlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-user-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
			<circle cx="9" cy="7" r="4" />
			<M.g
				animate={controls}
				initial="normal"
				style={{ transformOrigin: "19px 11px" }}
				variants={PLUS_VARIANTS}
			>
				<line x1="19" x2="19" y1="8" y2="14" />
				<line x1="22" x2="16" y1="11" y2="11" />
			</M.g>
		</svg>
	);
});
