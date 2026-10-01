export interface ServiceEndpoint { address: string; port: number; pid: number; url?: string }
interface SessionService {
	id: string;
	command: string;
	/** What the agent said the command is for; the row shows it instead of the shell line. */
	description?: string;
	pid?: number;
	startedAt: number;
	exitCode: number | null;
	finishedAt?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	endpoints: ServiceEndpoint[];
}
export interface SessionServices { jobs: SessionService[]; discoveryError?: string }

/**
 * A slice of a job's output, read from where the last one ended.
 *
 * `next` is the byte offset to ask from next time; ask from -1 to start near the end. `replace`
 * means the text is the whole of what there is rather than a continuation — a job that kept no log
 * file only has its in-memory copy.
 */
export interface ServiceOutput { text: string; next: number; done: boolean; replace?: boolean }
