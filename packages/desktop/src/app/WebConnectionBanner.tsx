import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.ts";
import { CONNECTION_EVENT, webConnection, type WebConnection } from "../services/web-bridge.ts";

/** How long a first connection may take before it is worth saying so. */
const FIRST_CONNECT_GRACE_MS = 2000;

/**
 * Says so when a browser opened through Web access has lost the desktop.
 *
 * Without it the page simply stops changing: a reply that stops mid-sentence, a button that does
 * nothing. That reads as the app having hung, when what happened is that the desktop went to sleep
 * or quit — and the page is already reconnecting on its own. Nothing in a window, where there is no
 * link to lose.
 */
export function WebConnectionBanner() {
	const { t } = useI18n();
	const [status, setStatus] = useState<WebConnection | null>(() => webConnection());
	const [slow, setSlow] = useState(false);

	useEffect(() => {
		if (webConnection() === null) return;
		const listener = (event: Event) => {
			if (event instanceof CustomEvent) setStatus(event.detail as WebConnection);
		};
		window.addEventListener(CONNECTION_EVENT, listener);
		// A first connection is usually there before anyone could read a banner about it.
		const timer = setTimeout(() => setSlow(true), FIRST_CONNECT_GRACE_MS);
		return () => {
			window.removeEventListener(CONNECTION_EVENT, listener);
			clearTimeout(timer);
		};
	}, []);

	if (status === null || status === "connected" || (status === "connecting" && !slow)) return null;

	return (
		<div
			role="status"
			className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4"
		>
			<div className="flex max-w-[560px] items-center gap-2 rounded-full border border-line bg-elevated px-3.5 py-1.5 text-detail text-ink shadow-lg shadow-black/20">
				<WifiOff size={13} strokeWidth={1.9} className="shrink-0 text-danger" aria-hidden />
				<span className="min-w-0 truncate">{status === "reconnecting" ? t("web.reconnecting") : t("web.connecting")}</span>
			</div>
		</div>
	);
}
