import type { Server } from "node:http";
import { closeListeningServer, type RunningApp } from "./app.ts";

/** The background service and model listener belong to this fixture even when an assertion fails. */
export async function stopWorkspaceFixture(
	app: RunningApp | undefined,
	server: Server | undefined,
	diagnostic: (message: string) => void,
): Promise<void> {
	try {
		if (app) {
			try {
				diagnostic("workspace teardown: looking up owned services");
				const jobs = await app.evaluate<{ jobs: { id: string }[] }>("window.plume.services.list('qa-short')").catch((error: unknown) => {
					diagnostic(`workspace teardown: service lookup failed: ${String(error)}`);
					return { jobs: [] };
				});
				for (const job of jobs.jobs) {
					diagnostic(`workspace teardown: requesting stop for service ${job.id}`);
					await app.evaluate(`window.plume.services.stop('qa-short',${JSON.stringify(job.id)},true)`).catch((error: unknown) => {
						diagnostic(`workspace teardown: stopping service ${job.id} failed: ${String(error)}`);
					});
				}
			} finally {
				diagnostic("workspace teardown: stopping Electron");
				await app.stop();
			}
		}
	} catch (error) {
		diagnostic(`workspace teardown: app cleanup failed: ${error instanceof Error ? error.stack : String(error)}`);
		throw error;
	} finally {
		// A failed taskkill must not strand the model listener and suppress the runner's failure report.
		diagnostic("workspace teardown: closing mock model server");
		await closeListeningServer(server);
		diagnostic(`workspace teardown: model listener active=${server?.listening ?? false}`);
	}
}
