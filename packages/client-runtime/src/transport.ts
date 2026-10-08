import type { MobileMethod } from "@plume/contract";
import { relayRoom } from "./relay.ts";
import type { ClientState, Connection, RemoteEvent } from "./types.ts";

interface Call { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Handlers {
	status(status: ClientState["status"]): void;
	ready(): void;
	event(event: RemoteEvent): void;
	error(error: Error): void;
}

/** 连接不认识 UI；断线只重读状态，不重放写操作。 */
export class RemoteTransport {
	private socket: WebSocket | null = null;
	private calls = new Map<string, Call>();
	private connection: Connection | null = null;
	private retry: ReturnType<typeof setTimeout> | null = null;
	private probe: ReturnType<typeof setTimeout> | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private deadline: ReturnType<typeof setTimeout> | null = null;
	private backoff = 500;
	private authenticated = false;
	private everConnected = false;
	private nextId = 0;
	private handlers: Handlers;
	private createSocket: (url: string) => WebSocket;

	constructor(handlers: Handlers, createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)) {
		this.handlers = handlers;
		this.createSocket = createSocket;
	}

	start(connection: Connection): void {
		this.stop();
		this.connection = connection;
		this.everConnected = false;
		this.backoff = 500;
		this.open();
		this.heartbeat = setInterval(() => this.wake(), 15_000);
	}

	stop(): void {
		this.connection = null;
		if (this.retry) clearTimeout(this.retry);
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.probe) clearTimeout(this.probe);
		if (this.deadline) clearTimeout(this.deadline);
		this.retry = this.heartbeat = this.probe = this.deadline = null;
		const socket = this.socket;
		this.socket = null;
		this.authenticated = false;
		socket?.close();
		this.rejectCalls();
		this.handlers.status("offline");
	}

	wake(): void {
		if (!this.connection) return;
		if (!this.socket) { this.open(); return; }
		if (!this.authenticated || this.probe) return;
		const current = this.socket;
		this.probe = setTimeout(() => {
			if (current !== this.socket) return;
			current.close();
			this.gone(current);
		}, 5000);
		current.send(JSON.stringify({ type: "ping" }));
	}

	call<T>(method: MobileMethod, args: unknown[] = []): Promise<T> {
		if (!this.authenticated || this.socket?.readyState !== 1) return Promise.reject(new Error("连接已断开，请重试"));
		return new Promise<T>((resolve, reject) => {
			const id = String(++this.nextId);
			const timer = setTimeout(() => { this.calls.delete(id); reject(new Error("桌面没有响应，请查看任务状态后重试")); }, 20_000);
			this.calls.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			try { this.socket!.send(JSON.stringify({ type: "rpc", id, method, args })); }
			catch { clearTimeout(timer); this.calls.delete(id); reject(new Error("发送失败，请重试")); }
		});
	}

	private open(): void {
		if (!this.connection || this.socket) return;
		if (this.retry) clearTimeout(this.retry);
		this.retry = null;
		this.handlers.status(this.everConnected ? "reconnecting" : "connecting");
		let current: WebSocket;
		const { url, token, relay } = this.connection;
		try { current = this.createSocket(relay ? url : url.replace(/^http/, "ws") + "/mobile"); }
		catch { this.later(); return; }
		this.socket = current;
		this.deadline = setTimeout(() => { current.close(); this.gone(current); }, 8000);
		const auth = () => current.send(JSON.stringify({ type: "auth", token }));
		// 经中转时，中转自己的 `ready`（两端接上了）和电脑认证通过的 `ready` 同名，靠这一步分开。
		let bridged = !relay;
		current.onopen = () => {
			if (current !== this.socket) return;
			// 经中转时先报房间号，等中转把两端接上再走和直连一样的认证。
			if (relay) current.send(JSON.stringify({ type: "hello", room: relayRoom(token), role: "mobile" }));
			else auth();
		};
		current.onmessage = ({ data }) => {
			if (current !== this.socket) return;
			if (this.probe) clearTimeout(this.probe);
			this.probe = null;
			let message;
			try { message = JSON.parse(String(data)); } catch { return; }
			if (!message || typeof message !== "object") return;
			if (!bridged) {
				// Lyra 中转的控制消息：电脑不在线时让手机等着，这段等待不算超时，电脑一上线就会 `ready`。
				if (message.type === "waiting") { if (this.deadline) clearTimeout(this.deadline); this.deadline = null; return; }
				if (message.type === "ready") {
					bridged = true;
					if (this.deadline) clearTimeout(this.deadline);
					this.deadline = setTimeout(() => { current.close(); this.gone(current); }, 8000);
					auth();
					return;
				}
				// `role-full` 多半是上一条连接还没被中转判死，退避后重试即可；其余是地址或协议不对。
				if (message.type === "error" && message.reason !== "role-full") this.handlers.error(new Error("中转服务器拒绝了连接，请检查地址后重试"));
				current.close();
				return;
			}
			// 电脑那端走了，中转只说一句 `peer-left`、连接还开着：当成断线，重连后重新排队。
			if (relay && message.type === "peer-left") { current.close(); this.gone(current); return; }
			if (message.type === "auth_error") { this.handlers.error(new Error("配对令牌无效，请重新配对")); this.stop(); return; }
			if (message.type === "ready") {
				if (message.version !== 1) { this.handlers.error(new Error("手机和桌面版本不兼容，请更新后重新连接")); this.stop(); return; }
				if (this.deadline) clearTimeout(this.deadline);
				this.deadline = null;
				this.authenticated = true;
				this.everConnected = true;
				this.backoff = 500;
				this.handlers.status("connected");
				this.handlers.ready();
			} else if (message.type === "rpc_result") {
				const call = this.calls.get(message.id);
				if (!call) return;
				clearTimeout(call.timer);
				this.calls.delete(message.id);
				if (message.ok) call.resolve(message.value);
				else call.reject(new Error(message.error || "调用失败"));
			} else if (message.type !== "pong") this.handlers.event(message as RemoteEvent);
		};
		current.onclose = () => this.gone(current);
		current.onerror = () => { current.close(); this.gone(current); };
	}

	private gone(current: WebSocket): void {
		if (current !== this.socket) return;
		if (this.deadline) clearTimeout(this.deadline);
		if (this.probe) clearTimeout(this.probe);
		this.probe = this.deadline = null;
		this.socket = null;
		this.authenticated = false;
		this.rejectCalls();
		this.handlers.status(this.everConnected ? "reconnecting" : "connecting");
		this.later();
	}

	private later(): void {
		if (!this.connection || this.retry) return;
		this.retry = setTimeout(() => { this.retry = null; this.open(); }, this.backoff);
		this.backoff = Math.min(this.backoff * 2, 10_000);
	}

	private rejectCalls(): void {
		for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error("连接已断开，请查看任务状态后重试")); }
		this.calls.clear();
	}
}
