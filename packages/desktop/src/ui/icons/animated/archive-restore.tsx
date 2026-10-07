// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 archive-restore，悬停时箭头往上提一下，盖子跟着抬起。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ARROW_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -2, 0], transition: { duration: 0.45, ease: "easeInOut" } },
};

const LID_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1, 0], transition: { duration: 0.45, delay: 0.05, ease: "easeInOut" } },
};

export const ArchiveRestoreIcon = forwardRef<SVGSVGElement, LucideProps>(function ArchiveRestoreIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-archive-restore ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				variants={LID_VARIANTS}
				width="20"
				height="5"
				x="2"
				y="3"
				rx="1"
			/>
			<path d="M4 8v11a2 2 0 0 0 2 2h2" />
			<path d="M20 8v11a2 2 0 0 1-2 2h-2" />
			<M.g
				animate={controls}
				variants={ARROW_VARIANTS}
			>
				<path d="m9 15 3-3 3 3" />
				<path d="M12 12v9" />
			</M.g>
		</svg>
	);
});
