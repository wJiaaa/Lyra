// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 mail，悬停时封口往下压一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const FLAP_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, 1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const MailIcon = forwardRef<SVGSVGElement, LucideProps>(function MailIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-mail ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.path
				animate={controls}
				variants={FLAP_VARIANTS}
				d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"
			/>
			<rect x="2" y="4" width="20" height="16" rx="2" />
		</svg>
	);
});
