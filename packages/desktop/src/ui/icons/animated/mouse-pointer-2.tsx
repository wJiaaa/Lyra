// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 mouse-pointer-2，悬停时像点了一下，朝指尖缩一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const POP_VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: [1, 0.85, 1], transition: { duration: 0.3, ease: "easeInOut" } },
};

export const MousePointer2Icon = forwardRef<SVGSVGElement, LucideProps>(function MousePointer2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-mouse-pointer-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={POP_VARIANTS}
				style={{ originX: 0, originY: 0 }}
				d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"
			/>
		</svg>
	);
});
