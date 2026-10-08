import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";
import type { MobileAccessStatus } from "@plume/contract";
import type { RemoteEvent } from "@plume/client-runtime";
import { relaySocketUrl } from "@plume/client-runtime";
import { MobileServer } from "./mobile-server.ts";
import { connectRelay, type RelayLink, type RelayState } from "./mobile-relay.ts";
import { mobileRpc, type MobileRpcDeps } from "./mobile-rpc.ts";

let server: MobileServer | null = null;
// `relay` 是规范化后的中转地址，空串表示不走中转。
let config = { enabled: false, port: 4517, token: randomBytes(32).toString("hex"), relay: "" };
let relay: RelayLink | null = null;
let relayState: RelayState | "off" = "off";
let path: string;
let deps: MobileRpcDeps;
let changing = false;

export async function configureMobileAccess(file: string, host: MobileRpcDeps): Promise<void> {
	path = file; deps = host;
	try {
		const saved = JSON.parse(await readFile(path, "utf8"));
		if (typeof saved.enabled !== "boolean" || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(saved.token)) throw new Error("Invalid mobile access settings");
		// 早于中转的配置文件没有这一项；写坏了的地址当成没填，不让它挡住整个手机访问。
		config = { ...saved, relay: typeof saved.relay === "string" ? relaySocketUrl(saved.relay) ?? "" : "" };
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	if (config.enabled) await startMobileAccess(config.port);
}

export function mobileAccessStatus(): MobileAccessStatus {
	const addresses = [...new Set(Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => `http://${entry.address}:${config.port}`)))];
	return { running: !!server, port: config.port, addresses, token: server ? config.token : null, clients: server?.clients ?? 0, relay: { url: config.relay, state: server && config.relay ? relayState : "off" } };
}

async function save(): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path + ".tmp", JSON.stringify(config), { mode: 0o600 });
	await rename(path + ".tmp", path);
}

async function change(action: () => Promise<void>): Promise<MobileAccessStatus> {
	if (changing) throw new Error("Mobile access is changing, please retry");
	changing = true;
	try { await action(); return mobileAccessStatus(); } finally { changing = false; }
}

export function startMobileAccess(port: number): Promise<MobileAccessStatus> {
	return change(async () => {
		if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535");
		await server?.stop(); server = null;
		const next = new MobileServer(config.token, (method, args) => mobileRpc(deps, method, args));
		try { await next.start(port); } catch (cause) { await next.stop(); throw cause; }
		server = next;
		config = { ...config, enabled: true, port };
		try { await save(); } catch (cause) { await server.stop(); server = null; config.enabled = false; throw cause; }
		linkRelay();
	});
}

export function stopMobileAccess(): Promise<MobileAccessStatus> {
	return change(async () => { config.enabled = false; unlinkRelay(); await server?.stop(); server = null; await save(); });
}

export function rotateMobileToken(): Promise<MobileAccessStatus> {
	return change(async () => {
		const wasRunning = !!server;
		unlinkRelay();
		await server?.stop(); server = null;
		config.token = randomBytes(32).toString("hex");
		await save();
		if (wasRunning) {
			const next = new MobileServer(config.token, (method, args) => mobileRpc(deps, method, args));
			await next.start(config.port); server = next;
			// 房间号由令牌派生：换了令牌就是换了房间，旧手机连同旧房间一起作废。
			linkRelay();
		}
	});
}

export function mobileBroadcast(event: RemoteEvent): void {
	// 请求调试、提供商负载和桌面能力不进入手机通道。
	if (event.type === "agent_event" && !["agent_start", "agent_end", "message_start", "message_update", "message_end", "approval_request", "approval_settled", "notice", "title"].includes(event.event.type)) return;
	server?.broadcast(event);
}
export async function closeMobileAccess(): Promise<void> { unlinkRelay(); await server?.stop(); server = null; }

/** 填空串就是不走中转。地址只在这里规范化一次，状态里给回去的就是会被拨的那个。 */
export function setMobileRelay(url: string): Promise<MobileAccessStatus> {
	return change(async () => {
		const next = url.trim() ? relaySocketUrl(url) : "";
		if (next === null) throw new Error("Relay address must be a ws://, wss://, http:// or https:// URL");
		config = { ...config, relay: next };
		await save();
		if (server) linkRelay();
	});
}

function linkRelay(): void {
	unlinkRelay();
	if (!server || !config.relay) return;
	relay = connectRelay(server, config.relay, config.token, (state) => { relayState = state; });
}

function unlinkRelay(): void {
	relay?.stop();
	relay = null;
	relayState = "off";
}
