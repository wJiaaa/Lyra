// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/hand.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const HandIcon = forwardRef<SVGSVGElement, LucideProps>(function HandIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			initial="normal"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			variants={{
				normal: { rotate: 0, originX: "50%", originY: "90%" },
				animate: {
					rotate: [0, -15, 10, -5, 0],
					transition: {
						duration: 0.8,
						ease: "easeInOut",
					},
				},
			}}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			ref={host}
			className={`lucide lucide-hand ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...(props as object)}
		>
			<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
			<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
			<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
			<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
		</M.svg>
	);
});
