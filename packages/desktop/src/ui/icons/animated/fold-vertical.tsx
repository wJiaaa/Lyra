// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 fold-vertical，悬停时上下两个箭头朝中线折一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const UP_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const DOWN_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const FoldVerticalIcon = forwardRef<SVGSVGElement, LucideProps>(function FoldVerticalIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-fold-vertical ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={UP_VARIANTS}
			>
				<path d="M12 22v-6" />
				<path d="m15 19-3-3-3 3" />
			</M.g>
			<M.g
				animate={controls}
				variants={DOWN_VARIANTS}
			>
				<path d="M12 8V2" />
				<path d="m15 5-3 3-3-3" />
			</M.g>
			<path d="M4 12H2" />
			<path d="M10 12H8" />
			<path d="M16 12h-2" />
			<path d="M22 12h-2" />
		</svg>
	);
});
