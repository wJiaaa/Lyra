// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 bug，悬停时左右扭一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const WIGGLE_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -8, 5.6, -2.8, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const BugIcon = forwardRef<SVGSVGElement, LucideProps>(function BugIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-bug ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={WIGGLE_VARIANTS}
			>
				<path d="M12 20v-9" />
				<path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z" />
				<path d="M14.12 3.88 16 2" />
				<path d="M21 21a4 4 0 0 0-3.81-4" />
				<path d="M21 5a4 4 0 0 1-3.55 3.97" />
				<path d="M22 13h-4" />
				<path d="M3 21a4 4 0 0 1 3.81-4" />
				<path d="M3 5a4 4 0 0 0 3.55 3.97" />
				<path d="M6 13H2" />
				<path d="m8 2 1.88 1.88" />
				<path d="M9 7.13V6a3 3 0 1 1 6 0v1.13" />
			</M.g>
		</svg>
	);
});
