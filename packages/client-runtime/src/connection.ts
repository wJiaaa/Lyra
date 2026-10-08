import { relaySocketUrl } from "./relay.ts";
import type { Connection } from "./types.ts";

export function normalizeConnection(url: string, token: string, relay = false): Connection {
	if (!token.trim()) throw new Error("请输入配对令牌");
	if (relay) {
		const socket = relaySocketUrl(url);
		if (!socket) throw new Error("请输入中转服务器地址");
		return { url: socket, token: token.trim(), relay: true };
	}
	const target = new URL(url.includes("://") ? url.trim() : "http://" + url.trim());
	if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== "/") {
		throw new Error("请输入桌面的 HTTP 或 HTTPS 地址");
	}
	return { url: target.origin, token: token.trim() };
}

/** 直连写 `url=`，中转写 `relay=`：一个码只带一条路，手机不在几条路之间猜。 */
export function pairingCode(connection: Connection): string {
	return "plume://pair?" + new URLSearchParams({ [connection.relay ? "relay" : "url"]: connection.url, token: connection.token }).toString();
}

export function parsePairingCode(code: string): Connection {
	const value = new URL(code.trim());
	if (value.protocol !== "plume:" || value.hostname !== "pair") throw new Error("这不是 Plume 的配对码");
	const token = value.searchParams.get("token") ?? "";
	const relay = value.searchParams.get("relay");
	return relay ? normalizeConnection(relay, token, true) : normalizeConnection(value.searchParams.get("url") ?? "", token);
}
