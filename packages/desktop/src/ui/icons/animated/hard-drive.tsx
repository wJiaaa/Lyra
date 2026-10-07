// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 hard-drive，悬停时两颗指示灯依次闪一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const BLINK_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: (i: number) => ({ opacity: [1, 0.2, 1], transition: { duration: 0.4, delay: i * 0.15, ease: "easeInOut" } }),
};

export const HardDriveIcon = forwardRef<SVGSVGElement, LucideProps>(function HardDriveIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-hard-drive ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				custom={1}
				variants={BLINK_VARIANTS}
				d="M10 16h.01"
			/>
			<path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
			<path d="M21.946 12.013H2.054" />
			<M.path
				animate={controls}
				custom={0}
				variants={BLINK_VARIANTS}
				d="M6 16h.01"
			/>
		</svg>
	);
});
