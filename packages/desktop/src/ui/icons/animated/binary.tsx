// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/binary.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const FLIP_DURATION = 0.12;
const FLIP_STAGGER = 0.06;

const FLIP_OUT_VARIANTS: Variants = {
	normal: (custom: number) => ({
		rotateX: 0,
		opacity: 1,
		transition: {
			duration: FLIP_DURATION,
			delay: custom * FLIP_STAGGER + FLIP_DURATION,
		},
	}),
	animate: (custom: number) => ({
		rotateX: -90,
		opacity: 0,
		transition: {
			duration: FLIP_DURATION,
			delay: custom * FLIP_STAGGER,
		},
	}),
};

const FLIP_IN_VARIANTS: Variants = {
	normal: (custom: number) => ({
		rotateX: 90,
		opacity: 0,
		transition: {
			duration: FLIP_DURATION,
			delay: custom * FLIP_STAGGER,
		},
	}),
	animate: (custom: number) => ({
		rotateX: 0,
		opacity: 1,
		transition: {
			duration: FLIP_DURATION,
			delay: custom * FLIP_STAGGER + FLIP_DURATION,
		},
	}),
};

export const BinaryIcon = forwardRef<SVGSVGElement, LucideProps>(function BinaryIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-binary ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.rect
				animate={controls}
				custom={0}
				height="6"
				initial="normal"
				rx="2"
				variants={FLIP_OUT_VARIANTS}
				width="4"
				x="6"
				y="4"
			/>
			<M.g
				animate={controls}
				custom={0}
				initial="normal"
				variants={FLIP_IN_VARIANTS}
			>
				<path d="M6 4h2v6" />
				<path d="M6 10h4" />
			</M.g>

			<M.g
				animate={controls}
				custom={1}
				initial="normal"
				variants={FLIP_OUT_VARIANTS}
			>
				<path d="M14 4h2v6" />
				<path d="M14 10h4" />
			</M.g>
			<M.rect
				animate={controls}
				custom={1}
				height="6"
				initial="normal"
				rx="2"
				variants={FLIP_IN_VARIANTS}
				width="4"
				x="14"
				y="4"
			/>

			<M.g
				animate={controls}
				custom={2}
				initial="normal"
				variants={FLIP_OUT_VARIANTS}
			>
				<path d="M6 14h2v6" />
				<path d="M6 20h4" />
			</M.g>
			<M.rect
				animate={controls}
				custom={2}
				height="6"
				initial="normal"
				rx="2"
				variants={FLIP_IN_VARIANTS}
				width="4"
				x="6"
				y="14"
			/>

			<M.rect
				animate={controls}
				custom={3}
				height="6"
				initial="normal"
				rx="2"
				variants={FLIP_OUT_VARIANTS}
				width="4"
				x="14"
				y="14"
			/>
			<M.g
				animate={controls}
				custom={3}
				initial="normal"
				variants={FLIP_IN_VARIANTS}
			>
				<path d="M14 14h2v6" />
				<path d="M14 20h4" />
			</M.g>
		</svg>
	);
});
