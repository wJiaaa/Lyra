// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/bot.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const BotIcon = forwardRef<SVGSVGElement, LucideProps>(function BotIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-bot ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M12 8V4H8" />
			<rect height="12" rx="2" width="16" x="4" y="8" />
			<path d="M2 14h2" />
			<path d="M20 14h2" />

			<M.line
				animate={controls}
				initial="normal"
				variants={{
					normal: { y1: 13, y2: 15 },
					animate: {
						y1: [13, 14, 13],
						y2: [15, 14, 15],
						transition: {
							duration: 0.5,
							ease: "easeInOut",
							delay: 0.2,
						},
					},
				}}
				x1={15}
				x2={15}
			/>

			<M.line
				animate={controls}
				initial="normal"
				variants={{
					normal: { y1: 13, y2: 15 },
					animate: {
						y1: [13, 14, 13],
						y2: [15, 14, 15],
						transition: {
							duration: 0.5,
							ease: "easeInOut",
							delay: 0.2,
						},
					},
				}}
				x1={9}
				x2={9}
			/>
		</svg>
	);
});
