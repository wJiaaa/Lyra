// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 database，悬停时顶盖和中间那圈依次抬一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LID_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const BAND_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1, 0], transition: { duration: 0.4, delay: 0.08, ease: "easeInOut" } },
};

export const DatabaseIcon = forwardRef<SVGSVGElement, LucideProps>(function DatabaseIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-database ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.ellipse
				animate={controls}
				variants={LID_VARIANTS}
				cx="12"
				cy="5"
				rx="9"
				ry="3"
			/>
			<path d="M3 5V19A9 3 0 0 0 21 19V5" />
			<M.path
				animate={controls}
				variants={BAND_VARIANTS}
				d="M3 12A9 3 0 0 0 21 12"
			/>
		</svg>
	);
});
