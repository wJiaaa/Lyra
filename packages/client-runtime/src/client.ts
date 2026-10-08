import type { AgentEvent, ApprovalDecision, SessionMeta, ThinkingLevel } from "@plume/core/client-types";
import { normalizeConnection } from "./connection.ts";
import { applySessionEvent } from "./session-event.ts";
import { RemoteTransport } from "./transport.ts";
import type { Bootstrap, ClientState, Connection, PromptImage, RemoteEvent, SessionSnapshot } from "./types.ts";

export class RemoteClient {
	private state: ClientState = { status: "offline", bootstrap: null, activeId: null, session: null, loading: false, error: null };
	private listeners = new Set<() => void>();
	private reading: { id: string; events: AgentEvent[] } | null = null;
	private first: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
	private transport: RemoteTransport;
	private generation = 0;

	constructor(createSocket?: (url: string) => WebSocket) {
		this.transport = new RemoteTransport({
			status: (status) => this.update({ status }),
			ready: () => {
				const generation = this.generation;
				void this.refresh().then(() => {
				if (generation !== this.generation) return;
				if (this.first) { clearTimeout(this.first.timer); this.first.resolve(); this.first = null; }
				}).catch((error: unknown) => { if (generation === this.generation) this.fail(error); });
			},
			event: (event) => this.receive(event),
			error: (error) => this.fail(error),
		}, createSocket);
	}

	getSnapshot = (): ClientState => this.state;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

	connect(connection: Connection): Promise<void> {
		this.disconnect();
		const valid = normalizeConnection(connection.url, connection.token, connection.relay);
		this.update({ bootstrap: null, session: null, activeId: null, error: null });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.fail(new Error("无法连接桌面，请检查地址和手机接入开关")); this.transport.stop(); }, 15_000);
			this.first = { resolve, reject, timer };
			this.transport.start(valid);
		});
	}

	disconnect(): void {
		this.generation++;
		if (this.first) { clearTimeout(this.first.timer); this.first.reject(new Error("连接已取消")); this.first = null; }
		this.reading = null;
		this.transport.stop();
	}

	wake(): void { this.transport.wake(); }

	async refresh(): Promise<void> {
		const generation = this.generation;
		const bootstrap = await this.transport.call<Bootstrap>("bootstrap");
		if (generation !== this.generation) return;
		this.update({ bootstrap, error: null });
		const id = this.state.activeId;
		if (id && bootstrap.sessions.some((session) => session.id === id)) await this.openSession(id);
		else if (id) this.update({ activeId: null, session: null });
	}

	async openSession(id: string): Promise<void> {
		const read = { id, events: [] as AgentEvent[] };
		this.reading = read;
		this.update({ activeId: id, session: this.state.session?.meta.id === id ? this.state.session : null, loading: true, error: null });
		try {
			let snapshot = await this.transport.call<SessionSnapshot | null>("sessions.get", [id]);
			if (this.reading !== read) return;
			if (snapshot) for (const event of read.events) snapshot = applySessionEvent(snapshot, event);
			this.update({ session: snapshot, loading: false });
		} catch (error) {
			if (this.reading === read) { this.update({ loading: false }); this.fail(error); }
		} finally { if (this.reading === read) this.reading = null; }
	}

	async createSession(projectId: string, modelId: string): Promise<void> {
		const snapshot = await this.transport.call<SessionSnapshot>("sessions.create", [projectId, modelId]);
		this.update({ activeId: snapshot.meta.id, session: snapshot });
		await this.refresh();
	}

	async prompt(text: string, images: PromptImage[] = []): Promise<void> {
		const id = this.state.activeId;
		if (!id || (!text.trim() && !images.length)) return;
		await this.transport.call("agent.prompt", images.length ? [id, text, images] : [id, text]);
	}
	async abort(): Promise<void> { if (this.state.activeId) await this.transport.call("agent.abort", [this.state.activeId]); }
	async approve(requestId: string, decision: ApprovalDecision): Promise<void> {
		if (this.state.activeId) await this.transport.call("agent.approve", [this.state.activeId, requestId, decision]);
	}
	async setModel(modelId: string): Promise<void> {
		if (!this.state.activeId) return;
		await this.transport.call("agent.setModel", [this.state.activeId, modelId]);
		await this.openSession(this.state.activeId);
	}
	async setThinking(thinking: ThinkingLevel | null): Promise<void> {
		if (!this.state.activeId) return;
		await this.transport.call("agent.setThinking", [this.state.activeId, thinking]);
		await this.openSession(this.state.activeId);
	}
	async archive(id: string, archived: boolean): Promise<void> {
		await this.transport.call("sessions.archive", [id, archived]);
		await this.refresh();
	}
	async rename(title: string): Promise<void> {
		if (!this.state.activeId) return;
		await this.transport.call("sessions.rename", [this.state.activeId, title]);
		await this.openSession(this.state.activeId);
	}
	closeSession(): void { this.reading = null; this.update({ activeId: null, session: null, loading: false }); }

	private receive(event: RemoteEvent): void {
		if (event.type === "bootstrap_changed") {
			const generation = this.generation;
			void this.refresh().catch((error: unknown) => { if (generation === this.generation) this.fail(error); });
			return;
		}
		if (event.type === "session_changed" && this.state.bootstrap) {
			const list = this.state.bootstrap.sessions.filter((meta) => meta.id !== event.change.id);
			if (event.change.meta) list.push(event.change.meta);
			this.update({ bootstrap: { ...this.state.bootstrap, sessions: list.sort((a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt) } });
			if (event.change.meta && this.state.session?.meta.id === event.change.id) this.update({ session: { ...this.state.session, meta: event.change.meta } });
			if (!event.change.meta && this.state.activeId === event.change.id) this.closeSession();
		}
		if (event.type === "agent_event" && this.state.bootstrap && (event.event.type === "agent_start" || event.event.type === "agent_end")) {
			const ids = this.state.bootstrap.runningSessionIds.filter((id) => id !== event.sessionId);
			if (event.event.type === "agent_start") ids.push(event.sessionId);
			this.update({ bootstrap: { ...this.state.bootstrap, runningSessionIds: ids } });
		}
		if (event.type !== "agent_event" || event.sessionId !== this.state.activeId) return;
		if (this.reading?.id === event.sessionId) this.reading.events.push(event.event);
		else if (this.state.session) this.update({ session: applySessionEvent(this.state.session, event.event) });
		if (event.event.type === "notice" && event.event.level !== "info") this.update({ error: event.event.message });
	}

	private fail(error: unknown): void {
		const value = error instanceof Error ? error : new Error(String(error));
		this.update({ error: value.message });
		if (this.first) { clearTimeout(this.first.timer); this.first.reject(value); this.first = null; }
	}
	private update(patch: Partial<ClientState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
}
