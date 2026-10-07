// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-headphone，悬停时耳机跟着节拍点两下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const BEAT_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1, 0, -1, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const FileHeadphoneIcon = forwardRef<SVGSVGElement, LucideProps>(function FileHeadphoneIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-headphone ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<M.path
				animate={controls}
				variants={BEAT_VARIANTS}
				d="M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0"
			/>
		</svg>
	);
});
