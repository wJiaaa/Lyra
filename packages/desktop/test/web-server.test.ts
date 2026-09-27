/**
 * Web access over a real port: who gets in, and what they hear.
 *
 * Real sockets because both things worth checking are about the wire — a cookie a browser would
 * or would not send, a bind that does or does not collide — and a fake server binds nothing.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_SETTINGS, type Settings } from "@lyra/core";
import { WebServer, cookie, webUrls } from "../electron/web-server.ts";
import { settingsForWeb } from "../electron/web-settings.ts";
import type { RpcDeps } from "../electron/web-rpc.ts";

/** High enough to be unused, offset per run so two runs do not collide. */
const PORT = 46100 + (process.pid % 200);
const TOKEN = "0123456789abcdef0123456789abcdef";

function server(): WebServer {
	const deps = {
		store: () => ({ listSessions: async () => [{ id: "s1" }] }),
		settings: () => DEFAULT_SETTINGS,
	} as unknown as RpcDeps;
	return new WebServer(deps);
}

const running: WebServer[] = [];
after(async () => {
	await Promise.all(running.map((s) => s.stop()));
});

async function started(port = PORT, token = TOKEN): Promise<WebServer> {
	const s = server();
	running.push(s);
	const status = await s.start(port, token);
	assert.equal(status.error, null);
	return s;
}

/** Open a socket and resolve once the server has said hello, or reject on refusal. */
function connect(port: number, headers: Record<string, string>): Promise<{ ws: WebSocket; frames: unknown[] }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
		const frames: unknown[] = [];
		ws.on("message", (data) => {
			const frame = JSON.parse(String(data)) as { type: string };
			frames.push(frame);
			if (frame.type === "hello") resolve({ ws, frames });
		});
		ws.on("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
		ws.on("error", reject);
	});
}

function next(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const listener = (data: unknown) => {
			const frame = JSON.parse(String(data)) as Record<string, unknown>;
			if (frame.type !== type) return;
			ws.off("message", listener);
			resolve(frame);
		};
		ws.on("message", listener);
	});
}

test("the token in the link becomes a cookie, and the address loses the token", async () => {
	await started();
	const res = await fetch(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, { redirect: "manual" });
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), "/");
	const [set] = res.headers.getSetCookie();
	assert.match(set, new RegExp(`^lyra_web=${TOKEN};`));
	assert.match(set, /HttpOnly/);
	assert.match(set, /SameSite=Strict/);
	assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("a wrong token, or none, is refused — files included", async () => {
	const wrong = await fetch(`http://127.0.0.1:${PORT}/?token=nope`, { redirect: "manual" });
	assert.equal(wrong.status, 401);
	assert.equal(wrong.headers.get("set-cookie"), null);
	const bare = await fetch(`http://127.0.0.1:${PORT}/assets/index.js`);
	assert.equal(bare.status, 401);
	const forged = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie: "lyra_web=nope" } });
	assert.equal(forged.status, 401);
});

test("with the cookie the app is served, and nothing but reads is", async () => {
	const page = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie: `lyra_web=${TOKEN}` } });
	// 200 once `pnpm build` has run, 503 with instructions before; never a refusal.
	assert.ok(page.status === 200 || page.status === 503, `got ${page.status}`);
	const post = await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { cookie: `lyra_web=${TOKEN}` } });
	assert.equal(post.status, 405);
});

test("a socket needs the cookie, and needs to come from this server's own page", async () => {
	await assert.rejects(connect(PORT, {}), /refused 401/);
	await assert.rejects(connect(PORT, { cookie: `lyra_web=${TOKEN}`, origin: "http://evil.example" }), /refused 401/);
	const { ws } = await connect(PORT, { cookie: `lyra_web=${TOKEN}`, origin: `http://127.0.0.1:${PORT}` });
	ws.close();
});

test("calls go through the allowlist, and pushes reach every browser", async () => {
	const s = running[0];
	const { ws } = await connect(PORT, { cookie: `lyra_web=${TOKEN}` });

	ws.send(JSON.stringify({ type: "rpc", id: "1", method: "sessions.list", args: [] }));
	assert.deepEqual(await next(ws, "rpc_result"), { type: "rpc_result", id: "1", ok: true, value: [{ id: "s1" }] });

	ws.send(JSON.stringify({ type: "rpc", id: "2", method: "terminal.write", args: ["t", "rm -rf /"] }));
	assert.deepEqual(await next(ws, "rpc_result"), { type: "rpc_result", id: "2", ok: false, error: "method-not-allowed" });

	ws.send(JSON.stringify({ type: "ping" }));
	await next(ws, "pong");

	const pushed = next(ws, "agent_event");
	s.broadcast("s1", { type: "agent_start" } as never);
	assert.deepEqual(await pushed, { type: "agent_event", sessionId: "s1", event: { type: "agent_start" } });
	assert.equal(s.status().clients, 1);
	ws.close();
});

test("settings pushed to browsers carry no secrets", async () => {
	const s = running[0];
	const { ws } = await connect(PORT, { cookie: `lyra_web=${TOKEN}` });
	const pushed = next(ws, "settings_changed");
	const secret: Settings = {
		...DEFAULT_SETTINGS,
		webAccess: { enabled: true, port: PORT, token: TOKEN },
		searchApiKeys: { tavily: "tvly-secret" },
	};
	s.broadcastSettings(secret);
	const frame = (await pushed) as { settings: Settings };
	assert.equal(frame.settings.webAccess.token, null);
	assert.deepEqual(frame.settings.searchApiKeys, {});
	assert.doesNotMatch(JSON.stringify(frame), new RegExp(TOKEN));
	ws.close();
});

test("starting twice with the same port and token leaves the first listener alone", async () => {
	const s = running[0];
	const { ws } = await connect(PORT, { cookie: `lyra_web=${TOKEN}` });
	const again = await s.start(PORT, TOKEN);
	assert.equal(again.error, null);
	assert.equal(again.running, true);
	assert.equal(ws.readyState, WebSocket.OPEN, "an identical start must not drop anyone");
	ws.close();
});

test("a new token drops every browser holding the old one", async () => {
	const s = running[0];
	const { ws } = await connect(PORT, { cookie: `lyra_web=${TOKEN}` });
	const closed = new Promise((resolve) => ws.once("close", resolve));
	const rotated = "fedcba9876543210fedcba9876543210";
	await s.start(PORT, rotated);
	await closed;
	await assert.rejects(connect(PORT, { cookie: `lyra_web=${TOKEN}` }), /refused 401/);
	const { ws: fresh } = await connect(PORT, { cookie: `lyra_web=${rotated}` });
	fresh.close();
});

test("a port that is taken is reported, not thrown", async () => {
	const other = server();
	running.push(other);
	const status = await other.start(PORT, TOKEN);
	assert.equal(status.running, false);
	assert.match(status.error ?? "", /EADDRINUSE/);
});

test("links carry the token, best address first, then this machine's own name", () => {
	assert.deepEqual(webUrls(["192.168.1.5", "172.17.0.1"], 4517, "t"), [
		"http://192.168.1.5:4517/?token=t",
		"http://172.17.0.1:4517/?token=t",
		"http://localhost:4517/?token=t",
	]);
});

test("the cookie is read by name, not by position", () => {
	assert.equal(cookie("a=1; lyra_web=abc; b=2", "lyra_web"), "abc");
	assert.equal(cookie("lyra_web_old=zzz", "lyra_web"), null);
	assert.equal(cookie(undefined, "lyra_web"), null);
});

test("the settings a browser sees drop keys, commands and the token", () => {
	const settings: Settings = {
		...DEFAULT_SETTINGS,
		providers: [{ ...(DEFAULT_SETTINGS.providers[0] ?? ({} as never)), apiKey: "sk-secret", headers: { authorization: "x" } } as never],
		hooks: { events: { PreToolUse: [{ hooks: [{ type: "command", command: "rm -rf ~" }] }] } },
		webAccess: { enabled: true, port: 1, token: "secret-token" },
	};
	const seen = settingsForWeb(settings);
	assert.equal(seen.providers[0]?.apiKey, "");
	assert.equal(seen.providers[0]?.headers, undefined);
	assert.deepEqual(seen.hooks, { events: {} });
	assert.deepEqual(seen.mcpServers, []);
	assert.deepEqual(seen.scheduledTasks, []);
	assert.equal(seen.webAccess.token, null);
	assert.equal(seen.webAccess.enabled, true, "whether it is on is not a secret");
});
