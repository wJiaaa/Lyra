// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/square-pen.tsx
// 动画照搬上游，只有时长改用项目的 DURATION.slow（340ms），和侧栏其余反馈同一节奏；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { DURATION } from "../../motion/tokens.ts";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PEN_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		x: 0,
		y: 0,
	},
	animate: {
		rotate: [-0.5, 0.5, -0.5],
		x: [0, -1, 1.5, 0],
		y: [0, 1.5, -1, 0],
	},
};

export const SquarePenIcon = forwardRef<SVGSVGElement, LucideProps>(function SquarePenIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-square-pen overflow-visible ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
			<M.path
				animate={controls}
				d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
				variants={PEN_VARIANTS}
				transition={{ duration: DURATION.slow / 1000 }}
			/>
		</svg>
	);
});
