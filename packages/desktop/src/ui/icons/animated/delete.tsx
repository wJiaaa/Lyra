// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 delete，悬停时整个键往左退一下。
// 上游的 delete 是垃圾桶，这里是 lucide 的退格键，所以不用它的。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const DeleteIcon = forwardRef<SVGSVGElement, LucideProps>(function DeleteIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-delete ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
				<path d="m12 9 6 6" />
				<path d="m18 9-6 6" />
			</M.g>
		</svg>
	);
});
