// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 key-round，悬停时像插在锁里一样拧一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const TURN_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -20, 0], transition: { duration: 0.5, ease: "easeInOut" } },
};

export const KeyRoundIcon = forwardRef<SVGSVGElement, LucideProps>(function KeyRoundIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-key-round ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={TURN_VARIANTS}
				style={{ originX: 0.675, originY: 0.325 }}
			>
				<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
				<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
			</M.g>
		</svg>
	);
});
