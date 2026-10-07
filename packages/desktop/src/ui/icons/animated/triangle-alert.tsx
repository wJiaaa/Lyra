// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 triangle-alert，悬停时感叹号左右抖一下。
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

export const TriangleAlertIcon = forwardRef<SVGSVGElement, LucideProps>(function TriangleAlertIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-triangle-alert ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
			<M.g
				animate={controls}
				variants={SHAKE_VARIANTS}
			>
				<path d="M12 9v4" />
				<path d="M12 17h.01" />
			</M.g>
		</svg>
	);
});
