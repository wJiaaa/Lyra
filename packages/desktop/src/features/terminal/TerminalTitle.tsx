/**
 * 终端那个标签上写什么：它正看着的那个 shell 的名字（「终端 2」），还没接上就写「终端」。
 *
 * 一屏开着几格终端时，顶上那排标签要分得出谁是谁。见 `PanelDefinition.tabTitle`。
 */

import { panelInstance } from "../../lib/panel-instance.ts";
import { savedTerminal, useTerminals } from "../../store/terminals.ts";
import { bridge } from "../../services/index.ts";
import { terminalSlot } from "./scope.ts";

export function TerminalTitle({ scope, kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const slot = terminalSlot(scope, panelInstance(kind));
	const title = useTerminals((state) => {
		const id = slot === undefined ? state.active : state.activeByScope[slot];
		const tab = state.tabs.find((entry) => entry.id === id);
		// 「终端 1 · node」：开着 dev server 的那一格，不用点开就认得出来。
		return tab && (tab.process ? `${tab.title} · ${tab.process}` : tab.title);
	});
	return <>{title ?? fallback}</>;
}

/**
 * 关掉一格终端：它看着的 shell 一起结束，最早那一格也一样。
 *
 * 弹出去的那一格是在另一个窗口里选的 shell，这个窗口的 store 未必知道，所以也看两边共用的那条记录。
 */
export function closeTerminal(scope: string, kind: string): void {
	const slot = terminalSlot(scope, panelInstance(kind))!;
	const id = useTerminals.getState().activeByScope[slot] || savedTerminal(slot);
	if (id) {
		bridge.terminal.kill(id);
		useTerminals.getState().remove(id);
	}
	useTerminals.getState().forget(slot);
}
