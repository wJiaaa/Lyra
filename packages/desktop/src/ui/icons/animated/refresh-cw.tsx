// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/refresh-cw.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const RefreshCwIcon = forwardRef<SVGSVGElement, LucideProps>(function RefreshCwIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			transition={{ type: "spring", stiffness: 250, damping: 25 }}
			variants={{
				normal: { rotate: "0deg" },
				animate: { rotate: "50deg" },
			}}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-refresh-cw ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
			<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
			<path d="M8 16H3v5" />
		</M.svg>
	);
});
