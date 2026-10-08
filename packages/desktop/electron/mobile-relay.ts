/**
 * 桌面外连中转的那一半，协议照上游 Lyra 的中转服务（`packages/relay/server.mjs`），这样已经部署好
 * 的 Lyra 中转可以直接用。
 *
 * 手机在移动网络、电脑在家里路由器后面时，两边谁也连不进谁；中转让两端都往外连，再把字节对拷。
 * 连上之后这条 socket 在桌面看来就是一部直连的手机：同样的帧，由同一个 `MobileServer.open` 处理。
 *
 * 和 Lyra 的不同：hello 不带 `assetKey`。Plume 手机是原生界面，不从中转拉网页资源，不开那条通道，
 * 中转也就不会往这边发 `asset_request`。
 */

import { WebSocket } from "ws";
import { relayRoom } from "@plume/client-runtime";
import type { MobileServer, MobileSession } from "./mobile-server.ts";

export type RelayState = "connecting" | "online" | "paired";

export interface RelayHandlers {
	state(state: RelayState): void;
	/** 一部手机进了房间；从这里起这条 socket 当成一个刚连上的客户端。 */
	joined(socket: WebSocket): void;
	/** 来自手机的一帧（中转自己的控制消息已经滤掉）。 */
	message(socket: WebSocket, text: string): void;
	/** 手机走了，连接留着等下一部。它在途的东西都属于那部手机。 */
	peerLeft(socket: WebSocket): void;
	/** 这条连接没了，不管是哪一端断的。 */
	left(socket: WebSocket): void;
}

/** 中转自己说的话，都是短 JSON 文本帧。 */
const RELAY_WORDS = new Set(["waiting", "ready", "peer-left", "error"]);
const FIRST_RETRY = 1000;
const MAX_RETRY = 30_000;

/**
 * 访问开着的时候一直保持一条到中转的连接。
 *
 * 重连不是可选的：这是一条跨公网的长连接，空闲超时、合盖、换网络都会断。断了不重连，手机那头
 * 看到的就是「电脑不回话了」，两边屏幕上都没有一句解释。
 */
export class RelayLink {
	private socket: WebSocket | null = null;
	private retry = FIRST_RETRY;
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private readonly url: string;
	private readonly token: string;
	private readonly handlers: RelayHandlers;

	constructor(url: string, token: string, handlers: RelayHandlers) {
		this.url = url;
		this.token = token;
		this.handlers = handlers;
	}

	start(): void {
		this.stopped = false;
		this.open();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const socket = this.socket;
		this.socket = null;
		socket?.close();
	}

	private open(): void {
		if (this.stopped) return;
		this.handlers.state("connecting");
		let socket: WebSocket;
		try { socket = new WebSocket(this.url); } catch { this.later(); return; }
		this.socket = socket;
		socket.on("open", () => {
			// 只报房间：中转拒收任何不像样的 hello，十秒不说话的连接也会被它关掉。
			socket.send(JSON.stringify({ type: "hello", room: relayRoom(this.token), role: "desktop" }));
			this.retry = FIRST_RETRY;
		});
		socket.on("message", (data: Buffer, isBinary: boolean) => {
			if (isBinary) return;
			const text = data.toString("utf8");
			if (text.length < 256) {
				let word: unknown = null;
				try { word = (JSON.parse(text) as { type?: unknown }).type; } catch { /* 不是控制消息 */ }
				if (typeof word === "string" && RELAY_WORDS.has(word)) {
					if (word === "waiting") this.handlers.state("online");
					else if (word === "ready") { this.handlers.state("paired"); this.handlers.joined(socket); }
					else if (word === "peer-left") { this.handlers.state("online"); this.handlers.peerLeft(socket); }
					// `error` 之后中转会关掉连接，交给 close 去重连。
					return;
				}
			}
			this.handlers.message(socket, text);
		});
		socket.on("close", () => {
			if (this.socket === socket) this.socket = null;
			this.handlers.left(socket);
			this.later();
		});
		// error 之后一定跟着 close；两处都重连会排出两个互相赛跑的重连。
		socket.on("error", () => socket.close());
	}

	private later(): void {
		if (this.stopped || this.timer) return;
		this.handlers.state("connecting");
		this.timer = setTimeout(() => { this.timer = null; this.open(); }, this.retry);
		this.timer.unref?.();
		this.retry = Math.min(this.retry * 2, MAX_RETRY);
	}
}

/**
 * 拨中转，并把每一段配对接到 `host` 上，当成一部直连的手机。
 *
 * 中转连接在手机走后不断，下一部手机来了还是这条 socket，所以会话跟着 `ready` / `peer-left`
 * 开合，而不是跟着 socket。
 */
export function connectRelay(host: MobileServer, url: string, token: string, state: (state: RelayState) => void): RelayLink {
	let session: MobileSession | null = null;
	const end = () => { session?.end(); session = null; };
	const link = new RelayLink(url, token, {
		state,
		joined: (socket) => {
			end();
			session = host.open({
				send: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(text); },
				// 关掉这条中转连接就是送走这部手机；RelayLink 随后会重新拨一条等下一部。
				close: (code, reason) => { if (code === 4008) socket.terminate(); else socket.close(code, reason); },
				get backlog() { return socket.bufferedAmount; },
			});
		},
		message: (_socket, text) => session?.receive(text),
		peerLeft: end,
		left: end,
	});
	// 停下时关掉 socket，随后的 close 会走 `left` 收掉会话，不必在这里另收一次。
	link.start();
	return link;
}
