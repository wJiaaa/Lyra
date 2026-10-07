// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/languages.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: { opacity: 1, pathLength: 1, pathOffset: 0 },
	animate: (custom: number) => ({
		opacity: [0, 1],
		pathLength: [0, 1],
		pathOffset: [1, 0],
		transition: {
			opacity: { duration: 0.01, delay: custom * 0.1 },
			pathLength: {
				type: "spring",
				duration: 0.5,
				bounce: 0,
				delay: custom * 0.1,
			},
		},
	}),
};

const SVG_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: {
		opacity: 1,
		transition: {
			staggerChildren: 0.1,
			delayChildren: 0.2,
		},
	},
};

export const LanguagesIcon = forwardRef<SVGSVGElement, LucideProps>(function LanguagesIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const svgControls = useAnimation();
	const pathControls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => {
			void svgControls.start("animate");
			void pathControls.start("animate");
		},
		() => {
			void svgControls.start("normal");
			void pathControls.start("normal");
		},
	);

	return (
		<M.svg
			animate={svgControls}
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			variants={SVG_VARIANTS}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-languages ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<M.path
				animate={pathControls}
				custom={3}
				d="m5 8 6 6"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={pathControls}
				custom={2}
				d="m4 14 6-6 3-3"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={pathControls}
				custom={1}
				d="M2 5h12"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={pathControls}
				custom={0}
				d="M7 2h1"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={pathControls}
				custom={3}
				d="m22 22-5-10-5 10"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={pathControls}
				custom={3}
				d="M14 18h6"
				variants={PATH_VARIANTS}
			/>
		</M.svg>
	);
});
