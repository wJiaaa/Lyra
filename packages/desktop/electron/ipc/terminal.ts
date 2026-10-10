/**
 * The terminal's IPC surface: messages in, registry calls out.
 *
 * Everything this forwards to — which shell an attach lands on, what survives a detach — lives in
 * `terminal-registry.ts`, which has no Electron in it and is tested directly.
 */

import { app, ipcMain } from "electron";
import { createRegistryEnv, readRegistryEnv } from "../terminal-env.ts";
import { createTerminalRegistry, type TerminalDeps } from "../terminal-registry.ts";

export type { LiveTerminal, TerminalDeps } from "../terminal-registry.ts";

export function registerTerminalIpc(deps: TerminalDeps): void {
	// Windows only: elsewhere a new shell rebuilds its environment from its own startup files.
	const fresh = process.platform === "win32" ? createRegistryEnv(() => readRegistryEnv()) : undefined;
	if (fresh) {
		fresh.refresh();
		app.on("browser-window-focus", () => fresh.refresh());
	}
	const registry = createTerminalRegistry({ ...deps, currentEnv: fresh && (() => fresh.current(process.env)) });
	const watched = new Set<number>();
	ipcMain.handle("terminal:list", async (_event, cwd: string) => registry.list(cwd));
	ipcMain.handle("terminal:list-all", async () => registry.listAll());
	ipcMain.handle("terminal:open", async (_event, cwd: string, cols: number, rows: number) => {
		await fresh?.settled();
		return registry.open(cwd, cols, rows);
	});
	// Fire-and-forget: nothing is waiting on the result, and a prediction that fails should not be
	// an error the renderer has to handle.
	ipcMain.on("terminal:prewarm", (_event, cwd: string, cols: number, rows: number) =>
		registry.prewarm(cwd, cols, rows),
	);
	ipcMain.handle("terminal:attach", async (event, id: string, cols: number, rows: number) => {
		const sender = event.sender;
		const owner = sender.id;
		if (!watched.has(owner)) {
			watched.add(owner);
			// A committed document replacement cannot run the old React cleanup either.
			sender.on("did-navigate", () => registry.detachOwner(owner));
			sender.on("render-process-gone", () => registry.detachOwner(owner));
			sender.once("destroyed", () => {
				registry.detachOwner(owner);
				watched.delete(owner);
			});
		}
		return registry.attach(id, cols, rows, owner);
	});
	ipcMain.on("terminal:detach", (_event, id: string, epoch: number) => registry.detach(id, epoch));
	ipcMain.on("terminal:write", (_event, id: string, data: string) => registry.write(id, data));
	ipcMain.on("terminal:resize", (_event, id: string, cols: number, rows: number) => registry.resize(id, cols, rows));
	ipcMain.on("terminal:kill", (_event, id: string) => registry.kill(id));
}
