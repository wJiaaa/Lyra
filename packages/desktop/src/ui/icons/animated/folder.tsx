// lucide-animated 没有收起的文件夹，这里拿它 folder-open 的动画配上 lucide 的 folder 形状（MIT，见 ./LICENSE）：
// https://github.com/pqoqubbw/icons/blob/main/icons/folder-open.tsx
// 项目展开、收起切换的就是这两个图标，悬停时得摇得一样。接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: {
		rotate: [0, -8, 6, -4, 0],
		transition: {
			ease: "easeInOut",
			rotate: {
				duration: 0.6,
			},
		},
	},
};

export const FolderIcon = forwardRef<SVGSVGElement, LucideProps>(function FolderIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("animate"),
		() => void controls.start("normal"),
	);

	return (
		<M.svg
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
			className={`lucide lucide-folder ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<M.path
				animate={controls}
				d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
				initial="normal"
				style={{ transformOrigin: "12px 12px" }}
				variants={VARIANTS}
			/>
		</M.svg>
	);
});
