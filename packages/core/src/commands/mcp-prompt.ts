/**
 * MCP 服务器提供的 prompt，在 `/` 菜单里是什么样、打出来的参数怎么对上它声明的参数。
 *
 * 纯函数，浏览器能用（经 `commands-view` 出去）：菜单的参数提示和发送前的缺参检查都在渲染进程做，
 * 真正去服务器取展开结果（`prompts/get`）的是持有连接的那一端——`McpManager.getPrompt`。
 */

import type { Invocation } from "./expand.ts";
import { splitArguments } from "./expand.ts";

/** 一个 prompt 声明的参数。字段照协议的 `PromptArgument`。 */
export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** `/` 菜单里的一条 MCP prompt。 */
export interface McpPromptEntry {
	/**
	 * 打在 `/` 后面的名字：`mcp__<服务器>__<prompt>`。
	 *
	 * 跟工具同一条命名规则（`qualifiedToolName`），同一台服务器的工具和 prompt 一眼能认出是一家的，
	 * 两台服务器都叫 `review` 的 prompt 也不会撞。
	 */
	name: string;
	/** 服务器的 id，取展开结果时按它找连接。 */
	server: string;
	/** 服务器在设置里叫什么，菜单右边那一栏写它。 */
	serverName: string;
	/** 服务器那边的原名，`prompts/get` 要的是它，不是上面那个改写过的。 */
	prompt: string;
	description: string;
	arguments: McpPromptArgument[];
}

/** 菜单里名字后面那一截灰字：必填的 `<名字>`，可选的 `[名字]`。没有参数就没有提示。 */
export function promptArgumentHint(entry: Pick<McpPromptEntry, "arguments">): string | undefined {
	if (entry.arguments.length === 0) return undefined;
	return entry.arguments.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(" ");
}

/** 名字对得上的那一条，大小写不论——`parseInvocation` 交来的名字已经是小写。 */
export function findPrompt<T extends { name: string }>(prompts: readonly T[], invocation: Invocation): T | undefined {
	const wanted = invocation.name.toLowerCase();
	return prompts.find((entry) => entry.name.toLowerCase() === wanted);
}

export type BoundPromptArguments = { ok: true; args: Record<string, string> } | { ok: false; missing: string[] };

/**
 * 把 `/名字` 后面打的那串字，对到 prompt 声明的参数上。
 *
 * - `名字=值` 按名字给；名字不是声明过的参数时，整段当普通的一个值。
 * - 只声明了一个参数时，后面整段原样就是它的值——不用为了一句带空格的话去加引号。
 * - 其余按声明的顺序一个个填；多出来的接在最后一个参数后面，不丢。
 *
 * 必填的没给就报出来，不发：服务器拿到缺参的请求只会回一个错误，而那时候草稿已经清掉了。
 */
export function bindPromptArguments(entry: Pick<McpPromptEntry, "arguments">, rest: string): BoundPromptArguments {
	const declared = entry.arguments;
	const args: Record<string, string> = {};
	const text = rest.trim();
	if (declared.length === 1 && text && !namedToken(text, declared)) {
		args[declared[0].name] = text;
	} else if (text) {
		const positional: string[] = [];
		for (const token of splitArguments(text)) {
			const named = namedToken(token, declared);
			if (named) args[named.name] = named.value;
			else positional.push(token);
		}
		const open = declared.filter((argument) => args[argument.name] === undefined);
		positional.forEach((value, index) => {
			const target = open[Math.min(index, open.length - 1)];
			if (!target) return;
			args[target.name] = args[target.name] === undefined ? value : `${args[target.name]} ${value}`;
		});
	}
	for (const [name, value] of Object.entries(args)) if (!value) delete args[name];
	const missing = declared.filter((argument) => argument.required && !args[argument.name]).map((argument) => argument.name);
	return missing.length > 0 ? { ok: false, missing } : { ok: true, args };
}

function namedToken(token: string, declared: readonly McpPromptArgument[]): { name: string; value: string } | null {
	const match = /^([A-Za-z_][\w-]*)=([\s\S]*)$/.exec(token);
	if (!match || !declared.some((argument) => argument.name === match[1])) return null;
	return { name: match[1], value: match[2].trim() };
}
