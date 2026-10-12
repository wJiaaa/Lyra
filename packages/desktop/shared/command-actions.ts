/**
 * 桌面端实现了的内置命令。输入框的 `/` 菜单和「设置 › 命令」页都按这一份列。
 *
 * 从前两边各写一份：菜单加上 `/plan` 时设置页那份没跟上，停在四条，设置页的「内置命令」
 * 里一直看不到它。
 */

import type { CommandAction } from "@plume/core/commands-builtin";

export const DESKTOP_COMMAND_ACTIONS: readonly CommandAction[] = ["compact", "clear", "manage-commands", "aside", "plan"];
