/**
 * The terminal pane's tabs, drawn in place of its title.
 *
 * Several shells can be running at once — one on a dev server, one for git, one for whatever you
 * are actually doing — and switching between them should not involve arranging panes. So the pane's
 * header carries the strip, the way a terminal emulator does.
 *
 * Every shell, not the current project's: a terminal you started stays reachable when you move to
 * another project or to none at all. See `store/terminals.ts`.
 *
 * The strip is bounded and scrolls. It shares its row with the pane's grip in the centre and the
 * full-screen and close buttons at the right, and those have to stay reachable however many tabs
 * there are — an unbounded strip pushed the last tab underneath the buttons, where it could be
 * seen and not clicked.
 *
 * `no-drag` throughout: this sits in the header, which is what moves the window, and a strip you
 * cannot click because the window slid out from under you is worse than no strip.
 */

import { translate } from "../../i18n/translate.ts";
import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTerminals } from "../../store/terminals.ts";
import { bridge } from "../../services/index.ts";
import { Sideways } from "../../ui/scroll/Sideways.tsx";
import { useTerminalScope } from "./scope.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { ClosableTab } from "../../ui/primitives/ClosableTab.tsx";

export function TerminalTabs() {
	const tabs = useTerminals((s) => s.tabs);
	const { active, scope, cwd } = useTerminalScope();
	const strip = useRef<HTMLDivElement>(null);


	/*
	 * Keep the selected tab in view.
	 *
	 * Selecting one is usually a click on a tab already on screen, but not always: opening a new
	 * one selects a tab that has just been added past the right edge, and closing the current one
	 * moves to a neighbour that may be off the left. Either way the strip should be showing what
	 * the pane is showing.
	 */
	useEffect(() => {
		if (!active) return;
		strip.current?.querySelector(`[data-tab="${CSS.escape(active)}"]`)?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
		// 渐隐不必在这里补一刀：`useSideways` 自己听着 scroll，滚进视野那一下它也听得见。
	}, [active]);

	/*
	 * Where a new shell starts: the current project, or home when there is none.
	 *
	 * Read here, at the moment one is asked for, and nowhere else. The strip used to be keyed by
	 * this — and to return `null` when it was empty, so with no project open there was no strip at
	 * all and no way back to a shell that was still running.
	 */
	const openAnother = async () => {
		const opened = await bridge.terminal.open(cwd, 80, 24);
		useTerminals.getState().add({ id: opened.id, title: opened.title }, scope);
	};

	const close = (id: string) => {
		bridge.terminal.kill(id);
		useTerminals.getState().remove(id);
	};


	return (
		// The header owns the space left by the grip and native controls; do not halve it again.
		<div className="no-drag flex min-w-0 flex-1 items-center gap-0.5">
			{/* 滚、渐隐、两头的方向键，都在这一个壳里——见 `Sideways`。 */}
			<Sideways
				trackRef={strip}
				outerClassName="flex-1"
				role="tablist"
				aria-label={translate("terminal.tabs")}
				className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
			>
				{tabs.map((tab) => (
					<ClosableTab
						key={tab.id}
						data-tab={tab.id}
						current={tab.id === active}
						onSelect={() => useTerminals.getState().select(tab.id, scope)}
						onClose={() => close(tab.id)}
						closeLabel={translate("terminal.closeOne", { name: tab.title })}
					>
						{tab.title}
					</ClosableTab>
				))}
			</Sideways>

			{/* Outside the scroller: "open another" must not be the thing that scrolls out of reach. */}
			<IconButton size="sm" label={translate("terminal.new")} onClick={() => void openAnother()} icon={<Plus size={13} strokeWidth={2} />} />
		</div>
	);
}
