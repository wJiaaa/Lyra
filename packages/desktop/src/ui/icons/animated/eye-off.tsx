// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/eye-off.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
	animate: {
		pathLength: [0, 2],
		opacity: [0, 1],
		pathOffset: [0, 2],
		transition: { duration: 0.6 },
	},
};

export const EyeOffIcon = forwardRef<SVGSVGElement, LucideProps>(function EyeOffIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-eye-off ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
			<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
			<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
			<M.path
				animate={controls}
				d="m2 2 20 20"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
