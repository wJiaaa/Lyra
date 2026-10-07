// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 circle-alert，悬停时感叹号左右抖一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SHAKE_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 1.5, -1, 0], transition: { duration: 0.45, ease: "easeInOut" } },
};

export const CircleAlertIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleAlertIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-alert ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.g
				animate={controls}
				variants={SHAKE_VARIANTS}
			>
				<line x1="12" x2="12" y1="8" y2="12" />
				<line x1="12" x2="12.01" y1="16" y2="16" />
			</M.g>
		</svg>
	);
});
