// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 minimize-2，悬停时整个图标缩小一圈，悬停期间停在那里；和上游 maximize-2 的往外撑正好相反。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

// 不学 maximize-2 让两个箭头各自往里走：两个拐角本来只隔 4，往里走 2 就在正中叠成一个十字。
const VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: 0.82 },
};

const TRANSITION: Transition = { type: "spring", stiffness: 250, damping: 25 };

export const Minimize2Icon = forwardRef<SVGSVGElement, LucideProps>(function Minimize2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-minimize-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={VARIANTS}
				transition={TRANSITION}
			>
				<path d="m14 10 7-7" />
				<path d="M20 10h-6V4" />
				<path d="m3 21 7-7" />
				<path d="M4 14h6v6" />
			</M.g>
		</svg>
	);
});
