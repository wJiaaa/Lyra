/**
 * MCP 的 prompts 那一半：列出来给 `/` 菜单，选中后取回展开的消息。
 *
 * 服务器不声明 `prompts` 能力就不问——协议里它是可选的，问一台不支持的服务器只会换回一个错误。
 * 列表要翻页（`nextCursor`），只拿第一页会让一台 prompt 多的服务器在菜单里少掉一截，而且没有人
 * 会发现少了。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpPromptEntry } from "../commands/mcp-prompt.ts";
import type { UserContent } from "../types.ts";
import { qualifiedToolName } from "./names.ts";
import type { McpServerConfig } from "./types.ts";

/** 防一台服务器的 `nextCursor` 永远不为空：翻到这么多页还没完，就当它坏了。 */
const MAX_PAGES = 50;

export async function listPrompts(client: Client, server: McpServerConfig, timeoutMs: number): Promise<McpPromptEntry[]> {
	if (!client.getServerCapabilities()?.prompts) return [];
	const raw: { name: string; description?: string; title?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const listed = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: timeoutMs });
		raw.push(...listed.prompts);
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	const used = new Set<string>();
	return raw.map((prompt) => {
		const name = qualifiedToolName(server.id, prompt.name, used);
		used.add(name);
		return {
			name,
			server: server.id,
			serverName: server.name,
			prompt: prompt.name,
			description: prompt.description ?? prompt.title ?? prompt.name,
			arguments: (prompt.arguments ?? []).map((argument) => ({
				name: argument.name,
				...(argument.description ? { description: argument.description } : {}),
				...(argument.required ? { required: true } : {}),
			})),
		};
	});
}

/**
 * `prompts/get` 回来的消息，摊成一条用户输入。
 *
 * 选一个 prompt 的意思是「替我说这些话」，所以不论服务器把哪一段标成 user 还是 assistant，
 * 都按先后接成这一条消息发出去——拆成几条、或者伪造一条助手回复插进历史，会让转录里出现
 * 一段模型从没说过的话。
 *
 * 资源只取文本；二进制的、只给链接的留一行地址，让模型知道那里有东西而不是悄悄少一块。
 */
export function promptContent(messages: readonly { role: string; content: unknown }[]): UserContent[] {
	const out: UserContent[] = [];
	for (const message of messages) {
		const block = message.content as Record<string, unknown> | undefined;
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
		else if (block.type === "image" && typeof block.data === "string") out.push({ type: "image", data: block.data, mimeType: String(block.mimeType ?? "image/png") });
		else if (block.type === "resource") {
			const resource = block.resource as Record<string, unknown> | undefined;
			if (typeof resource?.text === "string") out.push({ type: "text", text: resource.text });
			else if (resource?.uri) out.push({ type: "text", text: `[resource ${String(resource.uri)}]` });
		} else if (block.type === "resource_link" && typeof block.uri === "string") out.push({ type: "text", text: `[resource ${block.uri}]` });
		else if (block.type === "audio") out.push({ type: "text", text: "[audio omitted]" });
	}
	return out;
}
