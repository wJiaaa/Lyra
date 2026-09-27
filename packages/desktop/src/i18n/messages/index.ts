import type { UiLocale } from "@lyra/core";
import { en } from "./en.ts";
import { zhCN, type MessageCatalog, type MessageKey } from "./zh-CN.ts";

export type ResolvedUiLocale = Exclude<UiLocale, "system">;
export type { MessageKey };

export const MESSAGE_CATALOGS: Record<ResolvedUiLocale, MessageCatalog> = {
	"zh-CN": zhCN,
	en,
};
