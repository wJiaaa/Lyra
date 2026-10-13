// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 images，悬停时和 image 一样太阳升一下。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const SUN_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: [0, -1.5, 0], transition: { duration: 0.4, ease: "easeInOut" } },
};

export const ImagesIcon = forwardRef<SVGSVGElement, LucideProps>(function ImagesIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-images ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
			<path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
			<M.circle animate={controls} variants={SUN_VARIANTS} cx="13" cy="7" r="1" fill="currentColor" />
			<rect x="8" y="2" width="14" height="14" rx="2" />
		</svg>
	);
});
