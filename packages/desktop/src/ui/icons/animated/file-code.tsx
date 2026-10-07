// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 file-code，悬停时两个尖括号往外撑一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LEFT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const FileCodeIcon = forwardRef<SVGSVGElement, LucideProps>(function FileCodeIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-file-code ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<M.path
				animate={controls}
				variants={LEFT_VARIANTS}
				d="M10 12.5 8 15l2 2.5"
			/>
			<M.path
				animate={controls}
				variants={RIGHT_VARIANTS}
				d="m14 12.5 2 2.5-2 2.5"
			/>
		</svg>
	);
});
