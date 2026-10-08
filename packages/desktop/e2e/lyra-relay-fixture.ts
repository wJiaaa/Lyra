import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * 照 Lyra `packages/relay/server.mjs` 的对外行为写的替身：hello 进房，一个房间一台电脑一部手机，
 * 第二个同角色的被拒（`role-full`），配上了两边都收 `ready`，一边走了另一边收 `peer-left`、连接不断。
 * 测的是 Plume 两端说不说得通这套话，不是中转本身。
 */
export async function lyraRelay() {
	const rooms = new Map<string, Map<"desktop" | "mobile", WebSocket>>();
	const seats = new WeakMap<WebSocket, { room: string; role: "desktop" | "mobile" }>();
	const hellos: Record<string, unknown>[] = [];
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	const peerOf = (socket: WebSocket) => {
		const seat = seats.get(socket);
		if (!seat) return undefined;
		return rooms.get(seat.room)?.get(seat.role === "desktop" ? "mobile" : "desktop");
	};
	server.on("connection", (socket) => {
		socket.on("message", (data, isBinary) => {
			if (!seats.has(socket)) {
				const hello = JSON.parse(data.toString());
				hellos.push(hello);
				if (hello.type !== "hello" || !/^[a-f0-9]{64}$/.test(hello.room)) { socket.send(JSON.stringify({ type: "error", reason: "bad-hello" })); socket.close(); return; }
				const members = rooms.get(hello.room) ?? new Map();
				if (members.has(hello.role)) { socket.send(JSON.stringify({ type: "error", reason: "role-full" })); socket.close(); return; }
				members.set(hello.role, socket);
				rooms.set(hello.room, members);
				seats.set(socket, { room: hello.room, role: hello.role });
				if (members.size === 2) for (const member of members.values()) member.send(JSON.stringify({ type: "ready" }));
				else socket.send(JSON.stringify({ type: "waiting" }));
				return;
			}
			peerOf(socket)?.send(data, { binary: isBinary });
		});
		socket.on("close", () => {
			const seat = seats.get(socket);
			if (!seat) return;
			const peer = peerOf(socket);
			rooms.get(seat.room)?.delete(seat.role);
			peer?.send(JSON.stringify({ type: "peer-left" }));
		});
	});
	return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, hellos, close: () => new Promise<void>((resolve) => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }) };
}
