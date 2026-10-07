// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/send.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const SendIcon = forwardRef<SVGSVGElement, LucideProps>(function SendIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-send overflow-visible ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.g
				animate={controls}
				transition={{ duration: 0.5 }}
				variants={{
					normal: { x: 0, y: 0, scale: 1 },
					animate: {
						x: 3,
						y: -3,
						scale: 0.8,
					},
				}}
			>
				<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
				<path d="m21.854 2.147-10.94 10.939" />
			</M.g>
			<M.path
				animate={controls}
				d="M -3 28 C -0.5 26.8 1.6 24.6 3.3 22 C 4.8 19.7 5.2 17.6 4.2 16.1 C 3.2 14.7 1.4 14.5 0.3 15.8 C -0.9 17.2 -0.6 19.4 1.2 20.4 C 3.4 21.5 6.4 19.4 9 15.8"
				fill="none"
				initial={{ opacity: 0, pathLength: 0 }}
				stroke="currentColor"
				strokeDasharray="2 2"
				strokeWidth="1"
				transition={{ duration: 0.55, delay: 0.1 }}
				variants={{
					normal: {
						pathLength: 0,
						opacity: 0,
						translateX: -3,
						translateY: 3,
						transition: { duration: 0.3 },
					},
					animate: {
						pathLength: 1,
						opacity: 1,
						translateX: 0,
						translateY: 0,
					},
				}}
			/>
		</svg>
	);
});
