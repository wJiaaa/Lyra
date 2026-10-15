import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/types.ts";
import { normalizeServer } from "../plugins/loader.ts";
import { plumeHome } from "../session/store.ts";
import { withoutBom } from "../utils/bom.ts";

/** 不存在就是没分发过；读坏了要留诊断，但不能拖垮用户原有配置。 */
async function readLibraryFile(name: string): Promise<string | null> {
	const path = join(plumeHome(), "magpie", name);
	try {
		return withoutBom(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[magpie] 无法读取 ${path}`);
		return null;
	}
}

/** 每轮读取，与个人指令一起注入，不把共享指令复制进用户设置。 */
export async function magpieInstructions(): Promise<string> {
	const text = (await readLibraryFile("AGENTS.md")) ?? "";
	// shortcut: 最多注入 102400 个字符，需更长指令时改为按需读取。
	if (text.length > 100 * 1024) console.warn("[magpie] 全局指令超过 102400 个字符，仅加载开头部分");
	return text.slice(0, 100 * 1024).trim();
}

/** Claude 格式由 magpie 写入；沿用插件的转换器和 MCP 的占位符、权限、OAuth 流程。 */
export async function withMagpieMcp<T extends { mcpServers: McpServerConfig[] }>(settings: T): Promise<T> {
	const own = settings.mcpServers.filter((server) => server.managedBy !== "magpie");
	const raw = await readLibraryFile("mcp.json");
	if (raw === null) return { ...settings, mcpServers: own };
	const servers: McpServerConfig[] = [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) throw new Error("invalid MCP map");
		for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
			// 不把未知传输方式猜成 HTTP，也不静默丢掉错误的参数或请求头。
			if (!isRecord(config) || !validServer(config)) {
				console.warn(`[magpie] MCP 条目 ${name} 格式无效，已跳过`);
				continue;
			}
			const id = `magpie__${name}`;
			if (own.some((server) => server.id === id)) {
				console.warn(`[magpie] MCP 条目 ${name} 与已有服务器 ID 冲突，保留已有配置`);
				continue;
			}
			const server = normalizeServer(id, name, config, join(plumeHome(), "magpie"));
			if (server) servers.push({ ...server, managedBy: "magpie", enabled: config.disabled !== true });
		}
	} catch {
		// 不输出解析器的消息，JSON 错误中可能带有令牌或请求头原文。
		console.warn("[magpie] magpie/mcp.json 不是有效的 MCP 配置，已保留 Plume 自己的服务器");
	}
	return { ...settings, mcpServers: [...own, ...servers] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validServer(config: Record<string, unknown>): boolean {
	if (config.type !== undefined && (typeof config.type !== "string" || !["stdio", "http", "sse"].includes(config.type))) return false;
	if (config.disabled !== undefined && typeof config.disabled !== "boolean") return false;
	for (const key of ["env", "headers"]) {
		if (config[key] !== undefined && (!isRecord(config[key]) || Object.values(config[key]).some((value) => typeof value !== "string"))) return false;
	}
	if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((value) => typeof value !== "string"))) return false;
	if (config.type === "stdio" || (config.type === undefined && config.command !== undefined)) return typeof config.command === "string" && config.command.trim() !== "";
	return config.command === undefined && typeof config.url === "string" && config.url.trim() !== "";
}
