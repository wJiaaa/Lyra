/**
 * 不靠会话，临时连一次 MCP 服务器：设置页的状态和工具、新对话里 `/` 菜单的 prompt 都从这里来。
 *
 * 连接原本只存在于会话里，没开会话时设置页只能写「已启用」，新对话的 `/` 菜单里也看不到任何
 * prompt。这里临时连一次，列完就断开，不让服务器常驻。连上过的按启动配置记住：同一份配置再问一次
 * 不再冷启动一遍（npx 那类第一次要几十秒）；名字和来源不参与，改名不该重启服务。失败的不记，下次
 * 再试——缺的钥匙、断的网可能已经好了。
 */

import { McpManager, type McpServerConfig, type McpServerStatus } from "@plume/core";

const probed = new Map<string, Promise<McpServerStatus>>();

function probeKey(server: McpServerConfig): string {
	const { name: _name, origin: _origin, trustReadOnly: _trust, pinned: _pinned, ...launch } = server;
	return JSON.stringify(launch);
}

/** 配置没变、结果却该变了的时候（登录、退出登录）丢掉记着的那份，下次重新连。 */
export function forgetProbe(server: McpServerConfig): void {
	probed.delete(probeKey(server));
}

/** 几个会话手上的同一台服务器状态不一样时，先报有麻烦的那份：设置页是人来找原因、点重连的地方。 */
const TROUBLE: Record<McpServerStatus["state"], number> = { reconnecting: 0, failed: 1, "needs-login": 2, connecting: 3, connected: 4, disabled: 5 };

/**
 * 设置页上一台服务器的状态。有会话正连着它，就报会话手上的那份：断线重连、调用中途崩掉都只发生
 * 在那条连接上，临时探测连的是另一个进程，看到的永远是「刚启动、好好的」。没有会话连着才探测。
 */
export function mcpStatusFor(server: McpServerConfig, held: readonly McpServerStatus[]): Promise<McpServerStatus> {
	const live = held.filter((status) => status.id === server.id && status.state !== "disabled");
	if (live.length === 0) return probeMcp(server);
	return Promise.resolve(live.toSorted((a, b) => TROUBLE[a.state] - TROUBLE[b.state])[0]!);
}

export function probeMcp(server: McpServerConfig): Promise<McpServerStatus> {
	const key = probeKey(server);
	let status = probed.get(key);
	if (!status) {
		const manager = new McpManager();
		status = manager
			.connectAll([server])
			.then(([result]) => result!)
			.finally(() => manager.closeAll());
		probed.set(key, status);
		status.then(
			(result) => result.state === "connected" || probed.delete(key),
			() => probed.delete(key),
		);
	}
	return status;
}

/**
 * 连上一台服务器做一件事，做完就断。
 *
 * 给没有会话可借的时候用：新对话里选了一个 MCP prompt，要先把它展开才能发出去，而会话要等这句话
 * 发出去才建。
 */
export async function withMcpServer<T>(server: McpServerConfig, use: (manager: McpManager) => Promise<T>): Promise<T> {
	const manager = new McpManager();
	try {
		const [status] = await manager.connectAll([server]);
		if (status?.state !== "connected") throw new Error(status?.error ?? `MCP server "${server.name}" did not connect`);
		return await use(manager);
	} finally {
		await manager.dispose();
	}
}
