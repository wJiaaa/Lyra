/**
 * 终端那个标签上写什么：它正看着的那个 shell 的名字（「终端 2」），还没接上就写「终端」。
 *
 * 一屏开着几格终端时，顶上那排标签要分得出谁是谁。见 `PanelDefinition.tabTitle`。
 */

import { panelInstance } from "../../lib/panel-instance.ts";
import { useTerminals } from "../../store/terminals.ts";
import { bridge } from "../../services/index.ts";
import { terminalSlot } from "./scope.ts";

export function TerminalTitle({ scope, kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const slot = terminalSlot(scope, panelInstance(kind));
	const title = useTerminals((state) => {
		const id = slot === undefined ? state.active : state.activeByScope[slot];
		return state.tabs.find((tab) => tab.id === id)?.title;
	});
	return <>{title ?? fallback}</>;
}

/** 后开的那一格关掉：它看着的 shell 一起结束，不留一个谁也够不着的 pty。 */
export function closeTerminal(scope: string, instance: string): void {
	const slot = terminalSlot(scope, instance)!;
	const id = useTerminals.getState().activeByScope[slot];
	if (id) {
		bridge.terminal.kill(id);
		useTerminals.getState().remove(id);
	}
	useTerminals.getState().forget(slot);
}
