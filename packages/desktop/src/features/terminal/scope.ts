import { useContext } from "react";
import { SessionScope, usePanelKind, useScopedMeta, useScopedWorkspace } from "../../app/session-scope.tsx";
import { panelInstance } from "../../lib/panel-instance.ts";
import { useTerminals } from "../../store/terminals.ts";
import { bridge } from "../../services/index.ts";

/**
 * 一格终端记「它在看哪个 shell」用的键。
 *
 * 一屏可以开好几格终端（顶上的标签，见 `lib/panel-instance.ts`），每格各看各的 shell。最早那一格
 * 沿用这一屏的键——那是一屏只有一格终端时就记下的，重开应用还能接回原来那个 shell；后开的那几格
 * 在后面缀上自己的 id。
 */
export function terminalSlot(scope: string | undefined, instance: string | null): string | undefined {
	return instance ? `${scope ?? "@window"}#${instance}` : scope;
}

/** The pane and its tab title must select the same shell without changing another tile's focus. */
export function useTerminalScope() {
	const session = useContext(SessionScope);
	const scope = bridge.bootWindow?.panelScope === "window" ? undefined : session === null ? "@draft" : session;
	const kind = usePanelKind();
	const instance = kind ? panelInstance(kind) : null;
	const slot = terminalSlot(scope, instance);
	const meta = useScopedMeta();
	// A blank screen's shell starts in its own project, not in the one beside it that has focus.
	const workspace = useScopedWorkspace().workspace?.path ?? "";
	const active = useTerminals((state) => slot === undefined ? state.active : state.activeByScope[slot] ?? "");
	return { scope, slot, instance, active, cwd: meta?.cwd ?? workspace };
}
