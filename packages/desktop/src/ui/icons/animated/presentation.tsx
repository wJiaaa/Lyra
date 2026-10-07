// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 presentation，悬停时往上跳一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const PresentationIcon = forwardRef<SVGSVGElement, LucideProps>(function PresentationIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-presentation ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="M2 3h20" />
				<path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
				<path d="m7 21 5-5 5 5" />
			</M.g>
		</svg>
	);
});
