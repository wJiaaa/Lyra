/**
 * Keep command metadata in core so settings and hosts share one list without importing a UI component.
 * Hosts implement the actions and expose only those they support, so an unavailable action never
 * appears as a command that does nothing.
 */

/** 宿主要实现的那几个动作。加一个之前先问：它在没有窗口的地方是什么意思？ */
export type CommandAction =
	/** 把之前的对话压缩成摘要。 */
	| "compact"
	/** 开一个新对话。 */
	| "clear"
	/** 打开命令管理界面。没有界面的宿主不实现它，于是不提供这条命令。 */
	| "manage-commands"
	/** 写几行回顾：这个会话做到哪了、还剩什么。没有界面的宿主读整条转录就行，不实现它。 */
	| "recap";

export interface BuiltinCommand {
	name: string;
	description: string;
	action: CommandAction;
	argumentHint?: string;
}

/**
 * 内建命令的全集。
 *
 * 刻意很短。每加一条，`/` 菜单里就多一个跟用户自己写的命令抢名字的名字——而内建的永远赢
 * （见 `loadCommands` 的去重），所以一条内建命令的真实成本是「从此没人能用这个名字」。
 */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
	{ name: "compact", description: "把之前的对话压缩成摘要，腾出上下文", action: "compact", argumentHint: "可选：希望摘要保留的内容" },
	{ name: "clear", description: "开一个新对话", action: "clear" },
	{ name: "commands", description: "管理斜杠命令，或新建一个", action: "manage-commands" },
	{ name: "recap", description: "回顾这个会话做到哪了、还剩什么", action: "recap" },
];

/** 宿主实现了哪些动作，就提供哪些内建命令。 */
export function builtinCommandsFor(supported: readonly CommandAction[]): BuiltinCommand[] {
	const can = new Set(supported);
	return BUILTIN_COMMANDS.filter((command) => can.has(command.action));
}
