// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 message-square-warning，悬停时感叹号左右抖一下。
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

export const MessageSquareWarningIcon = forwardRef<SVGSVGElement, LucideProps>(function MessageSquareWarningIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-message-square-warning ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
			<M.g
				animate={controls}
				variants={SHAKE_VARIANTS}
			>
				<path d="M12 15h.01" />
				<path d="M12 7v4" />
			</M.g>
		</svg>
	);
});
