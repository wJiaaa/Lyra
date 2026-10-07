// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 folder-search，悬停时放大镜往左上探一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const NUDGE_VARIANTS: Variants = {
	normal: { x: 0, y: 0 },
	animate: { x: [0, -1.5, 0], y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const FolderSearchIcon = forwardRef<SVGSVGElement, LucideProps>(function FolderSearchIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-folder-search ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" />
			<M.g
				animate={controls}
				variants={NUDGE_VARIANTS}
			>
				<path d="m21 21-1.9-1.9" />
				<circle cx="17" cy="17" r="3" />
			</M.g>
		</svg>
	);
});
