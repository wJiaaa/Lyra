// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 code，悬停时两个尖括号往外撑一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const RIGHT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

const LEFT_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, -2, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const CodeIcon = forwardRef<SVGSVGElement, LucideProps>(function CodeIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-code ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={RIGHT_VARIANTS}
				d="m16 18 6-6-6-6"
			/>
			<M.path
				animate={controls}
				variants={LEFT_VARIANTS}
				d="m8 6-6 6 6 6"
			/>
		</svg>
	);
});
