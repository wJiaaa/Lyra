// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-image，悬停时太阳升一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SUN_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const FileImageIcon = forwardRef<SVGSVGElement, LucideProps>(function FileImageIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-image ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<M.circle
				animate={controls}
				variants={SUN_VARIANTS}
				cx="10"
				cy="12"
				r="2"
			/>
			<path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" />
		</svg>
	);
});
