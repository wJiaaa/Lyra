/**
 * Web access: the desktop serving its own interface to browsers on the local network.
 *
 * One HTTP server does three things. It hands out the renderer's built files (`web-app.ts`), so the
 * browser runs the same interface as the window, by construction the same version. It answers one
 * WebSocket per browser, over which the renderer's `window.lyra` calls arrive (`web-rpc.ts` says
 * which may) and the session events the windows get are pushed out as they happen. And it keeps
 * everyone else out.
 *
 * ## The token
 *
 * The link the settings page hands out carries it as `?token=`. The first request that presents it
 * is answered with an HttpOnly cookie and a redirect to the same address without it, and from then
 * on the cookie is the credential — for the files, and for the socket, which is same-origin and so
 * carries it without the page ever holding the secret. A request with neither is refused, files
 * included: the bundle is not secret, but a page that loads and then cannot connect is a worse
 * answer than one that says the link is wrong.
 *
 * Binding to every interface is what makes the phone on the same Wi-Fi able to reach it; the token
 * is the gate, and rotating it (a new one in settings, then a restart) is how every link handed out
 * so far is revoked.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, SideChatUpdate, Settings } from "@lyra/core";
import type { SessionChange, WebAccessStatus } from "./ipc-shapes.ts";
import { allowedMethods, callRpc, type RpcDeps } from "./web-rpc.ts";
import { serveApp } from "./web-app.ts";
import { settingsForWeb } from "./web-settings.ts";

const COOKIE = "lyra_web";

export class WebServer {
	private http: Server | null = null;
	private wss: WebSocketServer | null = null;
	private clients = new Set<WebSocket>();
	private token: string | null = null;
	private port = 0;
	private lastError: string | null = null;
	private readonly rpc: RpcDeps;

	constructor(rpc: RpcDeps) {
		this.rpc = rpc;
	}

	get running(): boolean {
		return this.http !== null;
	}

	/** Whether this is already serving exactly what was asked for. */
	serving(port: number, token: string): boolean {
		return this.http !== null && this.port === port && this.token === token;
	}

	/**
	 * Listen on `port` with `token`, replacing whatever was listening before.
	 *
	 * A failure to bind — the port is taken, most often — is reported in the status rather than
	 * thrown: the settings page shows it next to the switch, which is where someone can act on it.
	 */
	async start(port: number, token: string): Promise<WebAccessStatus> {
		if (this.serving(port, token)) return this.status();
		if (this.http) await this.stop();

		/*
		 * 白名单和契约先对上，再开始监听。`allowedMethods` 在两边不一致时抛——一台愿意提供
		 * 未声明方法的桌面端，不该把服务起起来。
		 */
		allowedMethods();

		const server = createServer((req, res) => void this.handleHttp(req, res));
		const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
		server.on("upgrade", (request, socket, head) => {
			if (!this.acceptsSocket(request)) {
				/*
				 * The refusal is a courtesy, and the socket may already be gone: writing to a pipe
				 * whose far end left throws `EPIPE`, and on a raw upgrade socket nothing listens for
				 * it — it would reach the top of the main process.
				 */
				socket.on("error", () => {});
				try {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				} catch {}
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws) => {
				this.clients.add(ws);
				ws.on("close", () => this.clients.delete(ws));
				ws.on("error", () => this.clients.delete(ws));
				ws.on("message", (data) => void this.onSocketMessage(ws, data));
				ws.send(JSON.stringify({ type: "hello", version: 1 }));
			});
		});

		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "0.0.0.0", () => resolve());
			});
		} catch (error) {
			wss.close();
			this.lastError = error instanceof Error ? error.message : String(error);
			return this.status();
		}

		this.http = server;
		this.wss = wss;
		this.port = port;
		this.token = token;
		this.lastError = null;
		return this.status();
	}

	async stop(): Promise<void> {
		for (const client of this.clients) client.close();
		this.clients.clear();
		this.wss?.close();
		this.wss = null;
		const server = this.http;
		this.http = null;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			// `close` waits for keep-alive connections to go idle; a browser tab left open would
			// hold a restart up for as long as it stayed open.
			server.closeAllConnections();
		});
	}

	status(): WebAccessStatus {
		const urls = this.running && this.token ? webUrls(localAddresses(), this.port, this.token) : [];
		return { running: this.running, port: this.port, urls, clients: this.clients.size, error: this.lastError };
	}

	broadcast(sessionId: string, event: AgentEvent): void {
		this.send({ type: "agent_event", sessionId, event });
	}

	broadcastSideChat(sessionId: string, event: SideChatUpdate): void {
		this.send({ type: "side_chat_event", sessionId, event });
	}

	broadcastSessionChange(change: SessionChange): void {
		this.send({ type: "session_changed", change });
	}

	broadcastSettings(settings: Settings): void {
		this.send({ type: "settings_changed", settings: settingsForWeb(settings) });
	}

	private send(message: unknown): void {
		if (this.clients.size === 0) return;
		const payload = JSON.stringify(message);
		for (const client of this.clients) {
			if (client.readyState === 1) client.send(payload);
		}
	}

	private async onSocketMessage(ws: WebSocket, raw: unknown): Promise<void> {
		let message: { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
		try {
			message = JSON.parse(String(raw)) as typeof message;
		} catch {
			return;
		}
		if (message.type === "ping") {
			if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" }));
			return;
		}
		if (message.type !== "rpc" || typeof message.id !== "string") return;

		const method = typeof message.method === "string" ? message.method : "";
		const args = Array.isArray(message.args) ? message.args : [];
		let result: Awaited<ReturnType<typeof callRpc>>;
		try {
			result = await callRpc(this.rpc, method, args);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (ws.readyState === 1) ws.send(JSON.stringify({ type: "rpc_result", id: message.id, ...result }));
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const target = req.url ?? "/";
		if (!URL.canParse(target, "http://localhost")) {
			res.writeHead(400).end();
			return;
		}
		const url = new URL(target, "http://localhost");
		const headers = {
			// The first request carries the token in its address; nothing this page links to
			// should be told that address.
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			// Nobody else's page gets to frame this one and click through it.
			"x-frame-options": "DENY",
		};

		const presented = url.searchParams.get("token");
		if (presented !== null) {
			if (!this.authorize(presented)) {
				refuse(res, headers);
				return;
			}
			url.searchParams.delete("token");
			res.writeHead(302, {
				...headers,
				"set-cookie": `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
				location: url.pathname + url.search,
			});
			res.end();
			return;
		}

		if (!this.authorize(cookie(req.headers.cookie, COOKIE))) {
			refuse(res, headers);
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, headers).end();
			return;
		}
		if (await serveApp(url.pathname, res, headers)) return;
		res.writeHead(404, headers).end();
	}

	/**
	 * A socket needs the cookie, and needs to come from this server's own page.
	 *
	 * The cookie is `SameSite=Strict`, which browsers apply to the WebSocket handshake too; the
	 * `Origin` check is the same rule said a second time, for a browser that does not.
	 */
	private acceptsSocket(request: IncomingMessage): boolean {
		const target = request.url ?? "/";
		if (!URL.canParse(target, "http://localhost") || new URL(target, "http://localhost").pathname !== "/ws") return false;
		const origin = request.headers.origin;
		if (origin && URL.canParse(origin) && new URL(origin).host !== request.headers.host) return false;
		return this.authorize(cookie(request.headers.cookie, COOKIE));
	}

	private authorize(candidate: string | null): boolean {
		if (!this.token || !candidate) return false;
		const a = Buffer.from(this.token);
		const b = Buffer.from(candidate);
		return a.length === b.length && timingSafeEqual(a, b);
	}
}

/** The one value of `name` in a Cookie header, or null. */
export function cookie(header: string | undefined, name: string): string | null {
	for (const part of (header ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
	}
	return null;
}

function refuse(res: ServerResponse, headers: Record<string, string>): void {
	res.writeHead(401, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(
		'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
			"<title>Lyra</title><body style=\"font:15px system-ui;margin:3em auto;max-width:32em;padding:0 1em\">" +
			"<h1 style=\"font-size:18px\">链接无效或已失效</h1>" +
			"<p>请在桌面端「设置 → Web 访问」里重新复制访问链接。</p>" +
			"<p lang=\"en\" style=\"color:#888\">This link is invalid or has expired. Copy a fresh one from Settings → Web access on the desktop.</p>",
	);
}

/**
 * The links to hand out: one per local-network address, best first, then this machine's own name
 * for itself — which reaches it from a browser on the same computer when there is no network at all.
 */
export function webUrls(addresses: string[], port: number, token: string): string[] {
	const query = `/?token=${encodeURIComponent(token)}`;
	return [...addresses.map((address) => `http://${address}:${port}${query}`), `http://localhost:${port}${query}`];
}

/*
 * Which of this machine's addresses to offer, and in what order.
 *
 * Every adapter gets an address, and most are not the one another device on the Wi-Fi can reach:
 * Docker bridges, VPN tunnels, VM host-only networks, proxy tools' fake-IP ranges. They look exactly
 * as valid as the real one, so they are named and pushed to the back rather than hidden — a setup
 * this list does not know still gets every address, just in a worse order.
 */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|ppp|zt|wg|Loopback|vEthernet|Hyper-V|VMware|VirtualBox|Npcap|Bluetooth|Mihomo|Clash|sing-box)/i;
/** `198.18.0.0/15` is reserved for benchmarking, and proxy tools use it as their fake-IP range. */
const BENCHMARK_NETWORK = /^198\.(?:18|19)\./;

function rank(address: string, name: string): number {
	if (VIRTUAL_INTERFACE.test(name) || BENCHMARK_NETWORK.test(address)) return 3;
	if (address.startsWith("192.168.")) return 0;
	if (address.startsWith("10.")) return 1;
	return 2;
}

export interface InterfaceEntry {
	address: string;
	family: string;
	internal: boolean;
}

export function rankAddresses(interfaces: Record<string, InterfaceEntry[] | undefined>): string[] {
	const found: { address: string; score: number }[] = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			// `169.254.x` is what an interface gives itself when DHCP never answered: it is a
			// symptom of no network, not an address anything can be reached on.
			if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
			found.push({ address: entry.address, score: rank(entry.address, name) });
		}
	}
	found.sort((a, b) => a.score - b.score);
	// Distinct: one adapter can hold the same address twice across aliases.
	return [...new Set(found.map((entry) => entry.address))];
}

function localAddresses(): string[] {
	return rankAddresses(networkInterfaces());
}
