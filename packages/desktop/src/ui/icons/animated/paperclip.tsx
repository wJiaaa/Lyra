// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 paperclip，悬停时左右晃两下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const WIGGLE_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -12, 8.4, -4.2, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const PaperclipIcon = forwardRef<SVGSVGElement, LucideProps>(function PaperclipIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-paperclip ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={WIGGLE_VARIANTS}
				d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
			/>
		</svg>
	);
});
