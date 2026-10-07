// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/circle-help.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, -10, 10, -10, 0] },
};

export const CircleQuestionMarkIcon = forwardRef<SVGSVGElement, LucideProps>(function CircleQuestionMarkIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-circle-question-mark ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<circle cx="12" cy="12" r="10" />
			<M.g
				animate={controls}
				transition={{
					duration: 0.5,
					ease: "easeInOut",
				}}
				variants={VARIANTS}
			>
				<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
				<path d="M12 17h.01" />
			</M.g>
		</svg>
	);
});
