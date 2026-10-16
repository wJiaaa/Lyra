/**
 * A web address in a reply: a click opens it where the setting says, a right-click asks where.
 *
 * The menu is the two places a page can open — the system browser, named, and the built-in one —
 * plus copying the address. Named because 「在 Google Chrome 中打开」 says which window is about to
 * come up; 「在系统浏览器打开」 makes you remember what the system browser is.
 */

import { type ReactNode, useContext, useEffect, useState } from "react";
import { SessionScope } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { ExternalLink, Globe, Link2 } from "../../ui/icons/index.ts";
import { ContextMenu, useContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { MenuItem, MenuSeparator } from "../../ui/overlay/Menu.tsx";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

// The default browser does not change while a menu is open; asked once per window, on first right-click.
let browserName: Promise<string> | null = null;

function useBrowserName(): string {
	const [name, setName] = useState("");
	useEffect(() => {
		let alive = true;
		// Wrapped like `open-targets.ts`: a bridge without the method throws on the property read, not in the promise.
		browserName ??= Promise.resolve()
			.then(() => bridge.system.defaultBrowser())
			.catch(() => "");
		void browserName.then((value) => alive && setName(value));
		return () => {
			alive = false;
		};
	}, []);
	return name;
}

export function WebLink({ href, children }: { href: string; children: ReactNode }) {
	// Context reads, not subscriptions: only a press needs them, and it reads the store then.
	const scoped = useContext(SessionScope);
	const menu = useContextMenu();
	const openBuiltin = () => {
		const state = useApp.getState();
		// A tab of this screen's conversation, whichever screen has the focus.
		const sessionId = scoped === undefined ? state.activeSessionId : scoped;
		// Its tab opens in this screen, live or not — see `reveal` in `useBrowserWorkspace`.
		void bridge.browser.command({ type: "open", url: href, sessionId, newTab: true }).catch((error: unknown) => state.notify(String(error), "error"));
	};
	return (
		<>
			<a
				href={href}
				onClick={(event) => {
					event.preventDefault();
					if (useApp.getState().settings?.browser?.openLinks === "builtin" && !event.shiftKey) openBuiltin();
					else void bridge.system.openExternal(href);
				}}
				onContextMenu={(event) => menu.show(event, undefined)}
			>
				{children}
			</a>
			{/* Beside the link, not in it: React bubbles through the portal, and a row's click would reach the link's too. */}
			{menu.open && <WebLinkMenu anchor={menu.anchor} href={href} onBuiltin={openBuiltin} onClose={menu.close} />}
		</>
	);
}

function WebLinkMenu({ anchor, href, onBuiltin, onClose }: { anchor: { x: number; y: number } | null; href: string; onBuiltin: () => void; onClose: () => void }) {
	const { t } = useI18n();
	const browser = useBrowserName();
	return (
		// `wide`: the first row carries a browser's name, and at the default 224px 「在 Google Chrome 中打开」 was cut off.
		<ContextMenu anchor={anchor} onClose={onClose} width="wide">
			<MenuItem icon={<ExternalLink {...ICON} />} onClick={() => void bridge.system.openExternal(href)}>
				{browser ? t("link.openIn", { name: browser }) : t("link.openInSystem")}
			</MenuItem>
			<MenuItem icon={<Globe {...ICON} />} onClick={onBuiltin}>
				{t("openTarget.builtinBrowser")}
			</MenuItem>
			<MenuSeparator />
			<MenuItem
				icon={<Link2 {...ICON} />}
				onClick={() => {
					void bridge.clipboard.write(href);
					useApp.getState().notify(t("link.copied"));
				}}
			>
				{t("link.copy")}
			</MenuItem>
		</ContextMenu>
	);
}
