// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 clipboard-paste，悬停时箭头往外推一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const ARROW_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ClipboardPasteIcon = forwardRef<SVGSVGElement, LucideProps>(function ClipboardPasteIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-clipboard-paste ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				variants={ARROW_VARIANTS}
			>
				<path d="M11 14h10" />
				<path d="m17 18 4-4-4-4" />
			</M.g>
			<path d="M16 4h2a2 2 0 0 1 2 2v1.344" />
			<path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" />
			<rect x="8" y="2" width="8" height="4" rx="1" />
		</svg>
	);
});
