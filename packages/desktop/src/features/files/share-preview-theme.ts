import { useEffect } from "react";
import { bridge } from "../../services/index.ts";
import { onAppearanceApplied } from "../settings/index.ts";
import { previewTheme } from "./preview-theme.ts";

/**
 * Keep the main process holding the theme a page in the conversation is given.
 *
 * `preview` checks a page in a window of its own before anyone sees it, and the screenshot it hands
 * the model should be the page the reader gets. The theme is only known here, worked out from the
 * document, so it is sent across every time it is applied — not only when a card happens to be up.
 */
export function useSharedPreviewTheme(): void {
	useEffect(() => {
		const share = () => bridge.setPreviewTheme?.(previewTheme(document.querySelector("[data-ly-transcript-rows]")));
		share();
		return onAppearanceApplied(share);
	}, []);
}
