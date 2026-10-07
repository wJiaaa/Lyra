// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 columns-2，悬停时中间的分隔线左右挪一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DIVIDER_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -3, 3, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export const Columns2Icon = forwardRef<SVGSVGElement, LucideProps>(function Columns2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-columns-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<M.path
				animate={controls}
				variants={DIVIDER_VARIANTS}
				d="M12 3v18"
			/>
		</svg>
	);
});
