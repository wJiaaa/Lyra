import { Component, createRef, type HTMLAttributes, type ReactNode } from "react";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { DURATION, EASING } from "../../ui/motion/tokens.ts";

interface Props extends HTMLAttributes<HTMLDivElement> {
	isHidden: boolean;
	/** 挂上来时不淡入——它不是新出现的一块，是顶替同一位置上已经在显示的那一块。见 `DockView`。 */
	quietEntrance?: boolean;
	header: ReactNode;
}

interface Snapshot {
	surface: DOMRect;
	headings: { element: Element; rect: DOMRect }[];
}

/** Keep layout work at the endpoints; only the compositor interpolates between them. */
export class PaneSurface extends Component<Props, Record<string, never>, Snapshot | null> {
	private element = createRef<HTMLDivElement>();
	private surface = createRef<HTMLDivElement>();
	private motions: Animation[] = [];
	// 只在挂上的那一刻读：之后被藏过一次就一直算「挂过」，由 render 接着管。
	private retained = Boolean(this.props.quietEntrance);

	// Hooks run after DOM mutations. A snapshot is needed before React writes the new box,
	// including the current visual position when a user reverses an unfinished transition.
	override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
		const element = this.surface.current;
		const root = this.element.current;
		if (!element || !root || previous.isHidden || this.props.isHidden) return null;
		const from = previous.style;
		const to = this.props.style;
		if (from?.left === to?.left && from?.top === to?.top && from?.width === to?.width && from?.height === to?.height) return null;
		return {
			surface: element.getBoundingClientRect(),
			headings: [...root.querySelectorAll("[data-dock-heading]")].map((element) => ({ element, rect: element.getBoundingClientRect() })),
		};
	}

	override componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
		if (!snapshot && !this.props.isHidden) return;
		for (const motion of this.motions) motion.cancel();
		this.motions = [];
		const element = this.surface.current;
		if (!snapshot || !element || this.element.current?.hasAttribute("data-ly-frozen") || document.documentElement.hasAttribute("data-dock-settling")) return;
		if (motionReduced()) return;
		const before = snapshot.surface;
		const after = element.getBoundingClientRect();
		if (!before.width || !before.height || !after.width || !after.height) return;
		const dx = before.left - after.left;
		const dy = before.top - after.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5) return;
		const options = { id: "ly-dock-geometry", duration: DURATION.base, easing: EASING.out };
		this.motions.push(element.animate([
			{ transform: `translate(${dx}px, ${dy}px) scale(${before.width / after.width}, ${before.height / after.height})` },
			{ transform: "none" },
		], options));
		// Titles follow the visible card without scaling their text or moving the action targets.
		const actions = this.element.current?.querySelector("[data-dock-actions]")?.getBoundingClientRect();
		for (const heading of snapshot.headings) {
			if (!heading.element.isConnected) continue;
			const end = heading.element.getBoundingClientRect();
			const start: Keyframe = { transform: `translate(${heading.rect.left - end.left}px, ${heading.rect.top - end.top}px)` };
			const finish: Keyframe = { transform: "none" };
			if (actions) {
				// Interpolated with the translation, this edge stays at the stationary actions boundary.
				// The title's half-width slot only lays out tabs; clipping there would hide a returning title.
				start.clipPath = `inset(-100vh ${heading.rect.left + end.width - actions.left}px -100vh -100vw)`;
				finish.clipPath = `inset(-100vh ${end.right - actions.left}px -100vh -100vw)`;
			}
			this.motions.push(heading.element.animate([start, finish], options));
		}
	}

	override componentWillUnmount() {
		for (const motion of this.motions) motion.cancel();
	}

	override render() {
		const { isHidden: _hidden, quietEntrance: _quiet, header, children, ...props } = this.props;
		if (this.props.isHidden) this.retained = true;
		return <div {...props} ref={this.element} inert={this.props.isHidden} data-dock-retained={this.retained ? "" : undefined}>
			{header}
			<div ref={this.surface} data-dock-motion className="relative flex min-h-0 min-w-0 flex-1 flex-col origin-top-left">{children}</div>
		</div>;
	}
}
