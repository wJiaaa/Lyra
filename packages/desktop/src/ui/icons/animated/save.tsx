// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 save，悬停时像按下去一样缩一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const POP_VARIANTS: Variants = {
	normal: { scale: 1 },
	animate: { scale: [1, 0.88, 1], transition: { duration: 0.3, ease: "easeInOut" } },
};

export const SaveIcon = forwardRef<SVGSVGElement, LucideProps>(function SaveIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-save ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={POP_VARIANTS}
			>
				<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
				<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
				<path d="M7 3v4a1 1 0 0 0 1 1h7" />
			</M.g>
		</svg>
	);
});
