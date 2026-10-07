// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-spreadsheet，悬停时四个格子依次画出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (i: number) => ({ pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.25, delay: i * 0.08, ease: "easeInOut" } }),
};

export const FileSpreadsheetIcon = forwardRef<SVGSVGElement, LucideProps>(function FileSpreadsheetIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-spreadsheet ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<M.path
				animate={controls}
				custom={0}
				variants={DRAW_VARIANTS}
				d="M8 13h2"
			/>
			<M.path
				animate={controls}
				custom={1}
				variants={DRAW_VARIANTS}
				d="M14 13h2"
			/>
			<M.path
				animate={controls}
				custom={2}
				variants={DRAW_VARIANTS}
				d="M8 17h2"
			/>
			<M.path
				animate={controls}
				custom={3}
				variants={DRAW_VARIANTS}
				d="M14 17h2"
			/>
		</svg>
	);
});
