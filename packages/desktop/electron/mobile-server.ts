import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { MOBILE_METHODS, type MobileMethod } from "@plume/contract";
import type { RemoteEvent } from "@plume/client-runtime";

/** 一部手机的那一端：直连时是一条 WebSocket，经中转时是中转连接上的一段配对。 */
export interface MobilePeer {
	send(text: string): void;
	close(code: number, reason?: string): void;
	/** 已写出但对端还没读走的字节数。 */
	readonly backlog: number;
}

/** 一段对话：收到的帧交给 `receive`，对端走了调 `end`。 */
export interface MobileSession {
	receive(raw: string): void;
	end(): void;
}

/**
 * 手机只拿到会话接口，不能调用桌面的文件、设置或系统 IPC。
 *
 * 直连和经中转走同一个 `open`：认证、限流、白名单都只有一份。中转那条连接会先后接待多部手机
 * （Lyra 中转在手机离开时只发 `peer-left`，连接不断），所以状态挂在会话上，而不是挂在 socket 上。
 */
export class MobileServer {
	private http: Server;
	private sockets: WebSocketServer;
	private paired = new Set<MobilePeer>();
	private sessions = new Set<MobileSession>();
	private token: string;
	private invoke: (method: MobileMethod, args: unknown[]) => Promise<unknown>;

	constructor(token: string, invoke: (method: MobileMethod, args: unknown[]) => Promise<unknown>) {
		this.token = token;
		this.invoke = invoke;
		this.http = createServer((request, response) => {
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("Content-Type", "application/json");
			response.writeHead(request.method === "GET" && request.url === "/health" ? 200 : 404);
			response.end(JSON.stringify({ app: "Plume" }));
		});
		// 一条消息最多带 4 张图（见 mobile-rpc），每张 base64 不过 5 MiB；认证前的帧另有 4 KiB 的限制。
		this.sockets = new WebSocketServer({ server: this.http, path: "/mobile", maxPayload: 24 * 1024 * 1024 });
		this.sockets.on("connection", (socket) => {
			const session = this.open({
				send: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(text); },
				// 积压断开用 terminate：正常 close 要先等那 8 MiB 写完，而读不动正是断开的原因。
				close: (code, reason) => { if (code === 4008) socket.terminate(); else socket.close(code, reason); },
				get backlog() { return socket.bufferedAmount; },
			});
			socket.on("error", () => socket.terminate());
			socket.on("close", () => session.end());
			socket.on("message", (raw) => session.receive(raw.toString()));
		});
	}

	open(peer: MobilePeer): MobileSession {
		const deadline = setTimeout(() => peer.close(4001, "Pairing required"), 5000);
		let busy = 0;
		const session: MobileSession = {
			receive: (raw) => void this.receive(peer, raw, deadline, () => busy, (delta) => { busy += delta; }),
			end: () => {
				clearTimeout(deadline);
				this.paired.delete(peer);
				this.sessions.delete(session);
			},
		};
		this.sessions.add(session);
		return session;
	}

	private async receive(peer: MobilePeer, raw: string, deadline: ReturnType<typeof setTimeout>, busy: () => number, count: (delta: number) => void): Promise<void> {
		if (!this.paired.has(peer) && raw.length > 4096) { peer.close(4001); return; }
		let message;
		try { message = JSON.parse(raw); } catch { peer.close(4002, "Invalid JSON"); return; }
		if (!message || typeof message !== "object") { peer.close(4002); return; }
		if (!this.paired.has(peer)) {
			const supplied = typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
			const expected = Buffer.from(this.token);
			if (message.type !== "auth" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
				this.send(peer, { type: "auth_error" }); peer.close(4001); return;
			}
			clearTimeout(deadline);
			this.paired.add(peer);
			this.send(peer, { type: "ready", version: 1 });
			return;
		}
		if (message.type === "ping") { this.send(peer, { type: "pong" }); return; }
		if (message.type !== "rpc" || typeof message.id !== "string" || message.id.length > 64 || !Array.isArray(message.args)) { peer.close(4002); return; }
		if (!MOBILE_METHODS.includes(message.method) || busy() >= 16) { this.send(peer, { type: "rpc_result", id: message.id, ok: false, error: "Unsupported or busy request" }); return; }
		count(1);
		try {
			const value = await this.invoke(message.method, message.args);
			this.send(peer, { type: "rpc_result", id: message.id, ok: true, value });
		} catch (cause) {
			this.send(peer, { type: "rpc_result", id: message.id, ok: false, error: cause instanceof Error ? cause.message : "Request failed" });
		} finally { count(-1); }
	}

	get clients(): number { return this.paired.size; }
	async start(port: number, host = "0.0.0.0"): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.http.once("error", reject);
			this.http.listen(port, host, () => { this.http.off("error", reject); resolve(); });
		});
		return (this.http.address() as { port: number }).port;
	}
	async stop(): Promise<void> {
		for (const socket of this.sockets.clients) socket.terminate();
		for (const session of this.sessions) session.end();
		this.paired.clear();
		await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}
	broadcast(event: RemoteEvent): void { for (const peer of this.paired) this.send(peer, event); }
	private send(peer: MobilePeer, value: unknown): void {
		// 慢客户端不能让桌面的 agent 事件无限堆积；重连后从存储重读快照。
		if (peer.backlog > 8 * 1024 * 1024) { peer.close(4008, "Backlog"); return; }
		peer.send(JSON.stringify(value));
	}
}
