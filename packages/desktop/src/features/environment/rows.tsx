/**
 * 卡片里每一节共用的那几样：一行的样子、小标题的样子。
 *
 * 一行的高度、圆角、悬停底色只在这里写一次——这张卡片和下面那张任务清单叠在一起，两张卡里的行
 * 要像一套东西。
 */

export const ROW =
	"flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-label text-ink transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover disabled:pointer-events-none disabled:opacity-50";

export function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
	return (
		<div className="flex h-7 items-center gap-2 px-2 text-caption text-ink-faint">
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{action}
		</div>
	);
}

/** 一节：上下各留一点，节与节之间那条线由卡片统一画，见 `EnvironmentCard`。 */
export function Section({ children, name }: { children: React.ReactNode; name: string }) {
	return (
		<section data-ly-environment-section={name} className="py-1">
			{children}
		</section>
	);
}
