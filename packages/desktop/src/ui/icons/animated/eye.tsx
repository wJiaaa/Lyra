// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/eye.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

export const EyeIcon = forwardRef<SVGSVGElement, LucideProps>(function EyeIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-eye ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
				style={{ originY: "50%" }}
				transition={{ duration: 0.4, ease: "easeInOut" }}
				variants={{
					normal: { scaleY: 1, opacity: 1 },
					animate: { scaleY: [1, 0.1, 1], opacity: [1, 0.3, 1] },
				}}
			/>
			<M.circle
				animate={controls}
				cx="12"
				cy="12"
				r="3"
				transition={{ duration: 0.4, ease: "easeInOut" }}
				variants={{
					normal: { scale: 1, opacity: 1 },
					animate: { scale: [1, 0.3, 1], opacity: [1, 0.3, 1] },
				}}
			/>
		</svg>
	);
});
