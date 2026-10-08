import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { RemoteClient, relayRoom } from "@plume/client-runtime";
import { MobileServer } from "../electron/mobile-server.ts";
import { connectRelay, type RelayState } from "../electron/mobile-relay.ts";
import { lyraRelay } from "../e2e/lyra-relay-fixture.ts";

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`等不到：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("经 Lyra 中转：手机等电脑、配对后照常认证与 RPC，手机走了电脑留在房间里接下一部", async (context) => {
	const relay = await lyraRelay();
	context.after(() => relay.close());
	const token = "f".repeat(64);
	const calls: string[] = [];
	const host = new MobileServer(token, async (method) => {
		calls.push(method);
		if (method === "bootstrap") return { name: "Plume", projects: [], models: [], defaultModelId: "", thinking: "off", sessions: [], runningSessionIds: [] };
		return null;
	});
	context.after(() => host.stop());

	// 手机先到：中转让它等着，这段等待不能被当成连接超时。
	const phone = new RemoteClient();
	context.after(() => phone.disconnect());
	const connected = phone.connect({ url: relay.url, token, relay: true });
	await until(() => relay.hellos.some((hello) => hello.role === "mobile"), "手机进房");

	const states: RelayState[] = [];
	const link = connectRelay(host, relay.url, token, (state) => states.push(state));
	context.after(() => link.stop());
	await connected;
	assert.equal(phone.getSnapshot().status, "connected");
	assert.equal(host.clients, 1);
	assert.deepEqual(calls, ["bootstrap"], "认证通过后的 RPC 和直连走同一份白名单");
	assert.ok(states.includes("paired"));

	const desktopHello = relay.hellos.find((hello) => hello.role === "desktop")!;
	assert.deepEqual(Object.keys(desktopHello).sort(), ["role", "room", "type"], "不带 assetKey，中转不会开网页资源通道");
	assert.equal(desktopHello.room, relayRoom(token));
	assert.ok(!JSON.stringify(relay.hellos).includes(token), "hello 里只有房间号");

	// 手机走了：电脑那条中转连接不断，会话收掉，状态回到等手机。
	phone.disconnect();
	await until(() => host.clients === 0 && states.at(-1) === "online", "电脑回到等待");

	// 第二部手机接着进同一个房间，用的还是电脑那条连接。
	const second = new RemoteClient();
	context.after(() => second.disconnect());
	await second.connect({ url: relay.url, token, relay: true });
	assert.equal(host.clients, 1);
	assert.equal(relay.hellos.filter((hello) => hello.role === "desktop").length, 1, "电脑没有重拨");
});

test("令牌不对的手机进得了房间、过不了电脑那关", async (context) => {
	const relay = await lyraRelay();
	context.after(() => relay.close());
	const token = "e".repeat(64);
	const host = new MobileServer(token, async () => null);
	context.after(() => host.stop());
	const link = connectRelay(host, relay.url, token, () => undefined);
	context.after(() => link.stop());
	await until(() => relay.hellos.length === 1, "电脑进房");

	// 冒名的手机知道房间号（比如中转运营方），但不知道令牌。
	const socket = new WebSocket(relay.url);
	context.after(() => socket.terminate());
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", room: relayRoom(token), role: "mobile" }));
	const [ready] = await once(socket, "message");
	assert.equal(JSON.parse(String(ready)).type, "ready");
	socket.send(JSON.stringify({ type: "auth", token: "wrong" }));
	const [reply] = await once(socket, "message");
	assert.equal(JSON.parse(String(reply)).type, "auth_error");
	assert.equal(host.clients, 0);
});
