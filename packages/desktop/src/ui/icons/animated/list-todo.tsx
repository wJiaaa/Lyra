// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 list-todo，悬停时勾重新打一遍。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DRAW_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: { pathLength: [0, 1], opacity: [0, 1], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ListTodoIcon = forwardRef<SVGSVGElement, LucideProps>(function ListTodoIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-list-todo ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M13 5h8" />
			<path d="M13 12h8" />
			<path d="M13 19h8" />
			<M.path
				animate={controls}
				variants={DRAW_VARIANTS}
				d="m3 17 2 2 4-4"
			/>
			<rect x="3" y="4" width="6" height="6" rx="1" />
		</svg>
	);
});
