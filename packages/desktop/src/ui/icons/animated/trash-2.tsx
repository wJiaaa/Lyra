// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/delete.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Transition, Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LID_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: -1.1 },
};

const SPRING_TRANSITION: Transition = {
	type: "spring",
	stiffness: 500,
	damping: 30,
};

export const Trash2Icon = forwardRef<SVGSVGElement, LucideProps>(function Trash2Icon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-trash-2 ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={LID_VARIANTS}
			>
				<path d="M3 6h18" />
				<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
			</M.g>
			<M.path
				animate={controls}
				d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8"
				transition={SPRING_TRANSITION}
				variants={{
					normal: { d: "M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8" },
					animate: { d: "M19 9v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V9" },
				}}
			/>
			<M.line
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={{
					normal: { y1: 11, y2: 17 },
					animate: { y1: 11.5, y2: 17.5 },
				}}
				x1="10"
				x2="10"
				y1="11"
				y2="17"
			/>
			<M.line
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={{
					normal: { y1: 11, y2: 17 },
					animate: { y1: 11.5, y2: 17.5 },
				}}
				x1="14"
				x2="14"
				y1="11"
				y2="17"
			/>
		</svg>
	);
});
