/**
 * A place in the window's toolbar that the screen below can draw into.
 *
 * The single screen's panel column puts its tab strip here in the tabs layout, rather than spending a
 * row of its own under the toolbar — see `ToolbarPanelBar`. Null outside a `WindowFrame`, and then the
 * column keeps its own row.
 */

import { createContext, useContext } from "react";

export const ToolbarSlot = createContext<HTMLElement | null>(null);

export function useToolbarSlot(): HTMLElement | null {
	return useContext(ToolbarSlot);
}
