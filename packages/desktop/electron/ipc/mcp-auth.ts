/**
 * 设置页 MCP 卡片上的「登录」「退出登录」「重新连接」。
 *
 * 登录在主进程里走完（`loginMcpServer`：本机回调、系统浏览器、换令牌），令牌进 vault。之后要让
 * 已经连着、或者正卡在「需要登录」的那几处换上新状态：活着的会话断开这台服务器再重载能力，设置页
 * 探测记着的那份丢掉。
 */

import { forgetTokens, loginMcpServer, usesOAuth, type McpServerConfig } from "@plume/core";
import { ipcMain } from "electron";
import { settings } from "../app-settings.ts";
import { forgetProbe } from "../mcp-probe.ts";
import { sessions } from "../session-hub.ts";
import { openExternalSafely } from "../window-security.ts";

type Outcome = { ok: true } | { ok: false; error: string };

/** 每个会话都把这台服务器断开、重连一遍：用的令牌变了，配置却没变，`connectAll` 自己看不出来。 */
async function reconnect(server: McpServerConfig): Promise<void> {
	forgetProbe(server);
	await Promise.allSettled(
		[...sessions.values()].map(async (session) => {
			await session.can.mcp.disconnect((one) => one.id === server.id);
			await session.reloadCapabilities();
		}),
	);
}

function find(serverId: string): McpServerConfig | undefined {
	return settings().mcpServers.find((server) => server.id === serverId);
}

export function registerMcpAuthIpc(): void {
	ipcMain.handle("plugins:mcpLogin", async (_event, serverId: string): Promise<Outcome> => {
		const server = find(serverId);
		if (!server || !usesOAuth(server)) return { ok: false, error: `No OAuth MCP server "${serverId}"` };
		try {
			await loginMcpServer(server, {
				open: (url) => {
					if (!openExternalSafely(url)) throw new Error(`Refused to open ${url}`);
				},
			});
			await reconnect(server);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	/*
	 * 「重新连接」：只动这一台，不重载整个会话的能力——技能、插件、扩展都与它无关。重连在后台进行，
	 * 设置页看到「连接中」会自己再问几次（见 `McpSettings`）。
	 */
	ipcMain.handle("plugins:mcpReconnect", async (_event, serverId: string): Promise<void> => {
		const server = find(serverId);
		if (!server) return;
		forgetProbe(server);
		await Promise.allSettled([...sessions.values()].map((session) => session.can.mcp.reconnect(serverId)));
	});

	ipcMain.handle("plugins:mcpLogout", async (_event, serverId: string): Promise<Outcome> => {
		const server = find(serverId);
		if (!server || !usesOAuth(server)) return { ok: false, error: `No OAuth MCP server "${serverId}"` };
		await forgetTokens(server);
		await reconnect(server);
		return { ok: true };
	});
}
