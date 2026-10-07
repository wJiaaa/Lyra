// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 library，悬停时斜靠的那本书往回立一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const LEAN_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: { rotate: [0, 12, 0], transition: { duration: 0.5, ease: "easeInOut" } },
};

export const LibraryIcon = forwardRef<SVGSVGElement, LucideProps>(function LibraryIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-library ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={LEAN_VARIANTS}
				style={{ originX: 1, originY: 1 }}
				d="m16 6 4 14"
			/>
			<path d="M12 6v14" />
			<path d="M8 8v12" />
			<path d="M4 4v16" />
		</svg>
	);
});
