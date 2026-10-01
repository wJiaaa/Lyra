import type { SandboxProcess } from "../kernel/services.ts";

export interface BackgroundJob {
	id: string;
	command: string;
	/** What the model said the command is for — the words a person reads instead of the shell line. */
	description?: string;
	startedAt: number;
	exitCode: number | null;
	finishedAt?: number;
	output: string;
	outputPath?: string;
	outputComplete?: boolean;
	outputError?: string;
	pid?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
}
interface OwnedJob { info: BackgroundJob; process: SandboxProcess }
const KEY = "backgroundJobs";

/** The only handles accepted by stop come from processes this session actually started. */
export class BackgroundJobs {
	private readonly entries = new Map<string, OwnedJob>();
	/**
	 * Jobs whose end the model must not be told about: someone stopped them, the model already read
	 * how they ended, or the person pressed stop while they ran. Telling it anyway either repeats
	 * what it knows or wakes a conversation the person just stopped.
	 */
	private readonly quiet = new Set<string>();
	private listener: ((job: BackgroundJob) => void) | null = null;
	add(info: BackgroundJob, process: SandboxProcess): void { this.entries.set(info.id, { info, process }); }
	get(id: string): BackgroundJob | undefined { return this.entries.get(id)?.info; }
	list(): BackgroundJob[] { return [...this.entries.values()].map(({ info }) => ({ ...info })); }
	/**
	 * Who hears about a job that ended on its own. Only a top-level session listens; a sub-agent's
	 * jobs live in its own state map and stay poll-only — see `reportsExit`.
	 */
	onFinished(listener: (job: BackgroundJob) => void): void { this.listener = listener; }
	/** Whether a job started here will be reported when it ends, so the model knows not to poll. */
	get reportsExit(): boolean { return this.listener !== null; }
	/** Called by whatever follows the process once it is gone. */
	finished(job: BackgroundJob): void {
		if (!this.quiet.has(job.id)) this.listener?.(job);
	}
	/** The model has read this job's final state; its end is no longer news. */
	observed(id: string): void {
		if (this.entries.get(id)?.info.finishedAt !== undefined) this.quiet.add(id);
	}
	/** Read when the report is about to go out: a stop or a read may have happened in between. */
	isQuiet(id: string): boolean { return this.quiet.has(id); }
	/** The person pressed stop: nothing running now may wake the session when it ends. */
	mute(): void {
		for (const { info } of this.entries.values()) if (info.finishedAt === undefined) this.quiet.add(info.id);
	}
	stop(id: string, force = false): boolean {
		const job = this.entries.get(id);
		if (!job || job.info.finishedAt !== undefined || job.info.status === "exited") return false;
		this.quiet.add(id);
		job.info.status = "stopping";
		try { job.process.kill(force ? "SIGKILL" : "SIGTERM"); }
		catch (error) { job.info.status = "failed"; job.info.error = String(error); throw error; }
		return true;
	}
	dispose(): void {
		const errors: unknown[] = [];
		for (const id of this.entries.keys()) {
			try { this.stop(id, true); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, "Failed to stop background jobs");
	}
}

export function backgroundJobs(state: Map<string, unknown>): BackgroundJobs {
	const current = state.get(KEY);
	if (current instanceof BackgroundJobs) return current;
	const registry = new BackgroundJobs();
	state.set(KEY, registry);
	return registry;
}
