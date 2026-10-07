// 来自 lucide-animated（MIT，见 ./LICENSE）：https://github.com/pqoqubbw/icons/blob/main/icons/cloud-download.tsx
// 动画照搬上游；接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import type { Variants } from "motion/react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const CLOUD_VARIANTS: Variants = {
	initial: { y: 2 },
	active: { y: 0 },
};

export const CloudDownloadIcon = forwardRef<SVGSVGElement, LucideProps>(function CloudDownloadIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-cloud-download ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
			<M.g
				animate={controls}
				transition={{
					duration: 0.3,
					ease: [0.68, -0.6, 0.32, 1.6],
				}}
				variants={CLOUD_VARIANTS}
			>
				<path d="M12 13v8l-4-4" />
				<path d="m12 21 4-4" />
			</M.g>
		</svg>
	);
});
