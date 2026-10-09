/**
 * What the status bar menu asked for, carried out here.
 *
 * The main process owns the menu and knows nothing about views; this owns the views and knows
 * nothing about menus. A command name is the whole contract between them, which is what lets the
 * menu gain an item without the renderer changing, and a view be renamed without the menu caring.
 *
 * Registered once, at the top of the app rather than inside whichever screen is mounted: a
 * command can arrive at any moment, including the moment the window is created to receive it.
 */

import { useEffect } from "react";
import { useApp } from "../../store/index.ts";
import { bridge } from "../../services/index.ts";

export function useTrayCommands(): void {
	useEffect(() => {
		return bridge.onTrayCommand((command) => {
			// Read at call time rather than closing over a snapshot: this listener outlives many
			// renders, and a captured action would go on writing to a store state long replaced.
			const app = useApp.getState();

			/*
			 * The one command with a subject: which conversation to open.
			 *
			 * A newly revealed window may still be loading its list. Resolve by ID through the
			 * same path as in-app notifications instead of silently losing a cold click.
			 */
			if (command.startsWith("open-session:")) {
				const id = command.slice("open-session:".length);
				void app.openSessionById(id);
				return;
			}

			switch (command) {
				case "new-session":
					// Switch first, then create. The other order shows the conversation appearing on
					// top of whatever screen was open, which reads as the app having lost its place.
					app.setView("chat");
					void app.newSession();
					break;
				case "pull-requests":
					app.setView("pull-requests");
					break;
				case "scheduled":
					app.setView("scheduled");
					break;
				case "settings":
					app.setView("settings");
					break;
				case "updates":
					// 关于 is where the version, the check button and the changelog live. It used to be
					// the bottom of 常规, which held a copy of the first two and none of the rest.
					app.setSettingsSection("about");
					app.setView("settings");
					break;
			}
		});
	}, []);
}
