// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 split，悬停时两个箭头各朝自己指的方向推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, 1.5, 0], y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const LEFT_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, -1.5, 0], y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const SplitIcon = forwardRef<SVGSVGElement, LucideProps>(function SplitIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-split ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={RIGHT_VARIANTS}
			>
				<path d="M16 3h5v5" />
				<path d="m15 9 6-6" />
			</M.g>
			<M.path
				animate={controls}
				variants={LEFT_VARIANTS}
				d="M8 3H3v5"
			/>
			<path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
		</svg>
	);
});
