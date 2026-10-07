// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/plus.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const PlusIcon = forwardRef<SVGSVGElement, LucideProps>(function PlusIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("animate"),
		() => void controls.start("normal"),
	);

	return (
		<M.svg
			animate={controls}
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			transition={{ type: "spring", stiffness: 100, damping: 15 }}
			variants={{
				normal: {
					rotate: 0,
				},
				animate: {
					rotate: 180,
				},
			}}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-plus ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</M.svg>
	);
});
