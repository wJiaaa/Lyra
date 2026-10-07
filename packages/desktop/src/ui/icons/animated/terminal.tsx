// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/terminal.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LINE_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: {
		opacity: [1, 0, 1],
		transition: {
			duration: 0.8,
			repeat: Number.POSITIVE_INFINITY,
			ease: "linear",
		},
	},
};

export const TerminalIcon = forwardRef<SVGSVGElement, LucideProps>(function TerminalIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-terminal ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<polyline points="4 17 10 11 4 5" />
			<M.line
				animate={controls}
				initial="normal"
				variants={LINE_VARIANTS}
				x1="12"
				x2="20"
				y1="19"
				y2="19"
			/>
		</svg>
	);
});
