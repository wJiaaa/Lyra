// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/folder-plus.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const PATH_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: (custom: number) => ({
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			duration: 0.4,
			ease: "easeInOut",
			delay: custom * 0.1,
			opacity: { delay: custom * 0.1 },
		},
	}),
};

export const FolderPlusIcon = forwardRef<SVGSVGElement, LucideProps>(function FolderPlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-folder-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
			<M.path
				animate={controls}
				custom={1}
				d="M12 10v6"
				initial="normal"
				variants={PATH_VARIANTS}
			/>
			<M.path
				animate={controls}
				custom={0}
				d="M9 13h6"
				initial="normal"
				variants={PATH_VARIANTS}
			/>
		</svg>
	);
});
