// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 wifi-off，悬停时那道斜线重新划一遍。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SLASH_VARIANTS: Variants = {
	initial: { pathLength: 1, opacity: 1 },
	active: { pathLength: [0, 1], opacity: [0, 1] },
};

export const WifiOffIcon = forwardRef<SVGSVGElement, LucideProps>(function WifiOffIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
	const controls = useAnimation();
	const { ref: host, M } = useHoverAnimation(
		ref,
		() => void controls.start("initial"),
		() => void controls.start("active"),
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
			className={`lucide lucide-wifi-off ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M12 20h.01" />
			<path d="M8.5 16.429a5 5 0 0 1 7 0" />
			<path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
			<path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
			<path d="M2 8.82a15 15 0 0 1 4.177-2.643" />
			<path d="M22 8.82a15 15 0 0 0-11.288-3.764" />
			<M.path d="m2 2 20 20" animate={controls} transition={{ duration: 0.4, ease: "easeInOut" }} variants={SLASH_VARIANTS} />
		</svg>
	);
});
