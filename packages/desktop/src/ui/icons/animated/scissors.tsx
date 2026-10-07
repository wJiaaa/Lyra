// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 scissors，悬停时两片刀刃绕着轴心剪两下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TRANSITION: Transition = { duration: 0.6, ease: "easeInOut" };

const UPPER_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -10, 0, -10, 0], transition: TRANSITION },
};

const LOWER_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, 10, 0, 10, 0], transition: TRANSITION },
};

export const ScissorsIcon = forwardRef<SVGSVGElement, LucideProps>(function ScissorsIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-scissors ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={UPPER_VARIANTS}
				style={{ originX: 9 / 17, originY: 9 / 17 }}
			>
				<circle cx="6" cy="6" r="3" />
				<path d="M8.12 8.12 12 12" />
				<path d="M14.8 14.8 20 20" />
			</M.g>
			<M.g
				animate={controls}
				variants={LOWER_VARIANTS}
				style={{ originX: 9 / 17, originY: 8 / 17 }}
			>
				<path d="M20 4 8.12 15.88" />
				<circle cx="6" cy="18" r="3" />
			</M.g>
		</svg>
	);
});
