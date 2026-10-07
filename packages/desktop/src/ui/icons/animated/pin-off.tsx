// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 pin-off，悬停时图钉绕着针尖晃两下，那道斜线不动。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PIN_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -12, 8, -4, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const PinOffIcon = forwardRef<SVGSVGElement, LucideProps>(function PinOffIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-pin-off ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={PIN_VARIANTS}
				style={{ originX: 7 / 13, originY: 1 }}
			>
				<path d="M12 17v5" />
				<path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
				<path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
			</M.g>
			<path d="m2 2 20 20" />
		</svg>
	);
});
