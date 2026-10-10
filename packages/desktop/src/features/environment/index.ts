/**
 * 环境卡片，对外的那一面。
 *
 * 别的域只能从这里拿东西，不能伸进这个目录里的文件——那条规则由 `pnpm arch` 执行。
 */

import { provideEnvironmentCard } from "../../store/environment-card.ts";
import { EnvironmentCard } from "./EnvironmentCard.tsx";

// 对话区画卡片靠这一句登记，见 `store/environment-card.ts` 的 `provideEnvironmentCard`。
provideEnvironmentCard(EnvironmentCard);

export { EnvironmentToggle } from "./EnvironmentToggle.tsx";
