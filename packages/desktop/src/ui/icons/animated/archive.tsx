// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/archive.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const RECT_VARIANTS: Variants = {
	normal: {
		translateY: 0,
		transition: {
			duration: 0.2,
			type: "spring",
			stiffness: 200,
			damping: 25,
		},
	},
	animate: {
		translateY: -1.5,
		transition: {
			duration: 0.2,
			type: "spring",
			stiffness: 200,
			damping: 25,
		},
	},
};

const PATH_VARIANTS: Variants = {
	normal: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" },
	animate: { d: "M4 11v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11" },
};

const SECONDARY_PATH_VARIANTS: Variants = {
	normal: { d: "M10 12h4" },
	animate: { d: "M10 15h4" },
};

export const ArchiveIcon = forwardRef<SVGSVGElement, LucideProps>(function ArchiveIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-archive ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				height="5"
				initial="normal"
				rx="1"
				variants={RECT_VARIANTS}
				width="20"
				x="2"
				y="3"
			/>
			<M.path
				animate={controls}
				d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				d="M10 12h4"
				variants={SECONDARY_PATH_VARIANTS}
			/>
		</svg>
	);
});
