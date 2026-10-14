// lucide-animated 没有这个图标，照它的写法补的：形状是 lucide 的 git-fork，悬停时照 git-branch 那样按笔顺依次画出来。
// 接口和触发方式的改法见 ../index.ts。

import type { LucideProps } from "lucide-react";
import { useAnimation } from "motion/react";
import { forwardRef } from "react";
import { useHoverAnimation } from "../useHoverAnimation.ts";

const DURATION = 0.3;

const CALCULATE_DELAY = (i: number) => {
	if (i === 0) return 0.1;

	return i * DURATION + 0.1;
};

const DRAW = {
	normal: { pathLength: 1, opacity: 1, transition: { delay: 0 } },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
	},
};

const step = (i: number) => ({
	duration: DURATION,
	delay: CALCULATE_DELAY(i),
	opacity: { delay: CALCULATE_DELAY(i) },
});

export const GitForkIcon = forwardRef<SVGSVGElement, LucideProps>(function GitForkIcon({ className, size = 24, strokeWidth = 2, ...props }, ref) {
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
			className={`lucide lucide-git-fork ${className ?? ""}`.trimEnd()}
			aria-hidden="true"
			{...props}
		>
			<M.circle animate={controls} cx="12" cy="18" r="3" transition={step(0)} variants={DRAW} />
			<M.path animate={controls} d="M12 12v3" transition={step(1)} variants={DRAW} />
			<M.path animate={controls} d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" transition={step(1)} variants={DRAW} />
			<M.circle animate={controls} cx="6" cy="6" r="3" transition={step(2)} variants={DRAW} />
			<M.circle animate={controls} cx="18" cy="6" r="3" transition={step(2)} variants={DRAW} />
		</svg>
	);
});
