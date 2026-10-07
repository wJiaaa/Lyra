// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/panel-right-open.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DEFAULT_TRANSITION: Transition = {
	times: [0, 0.4, 1],
	duration: 0.5,
};

const PATH_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 0] },
};

export const PanelRightOpenIcon = forwardRef<SVGSVGElement, LucideProps>(function PanelRightOpenIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-panel-right-open ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<rect height="18" rx="2" width="18" x="3" y="3" />
			<path d="M15 3v18" />
			<M.path
				animate={controls}
				d="m10 15-3-3 3-3"
				transition={DEFAULT_TRANSITION}
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
