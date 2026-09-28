import type { UiLocale } from "@plume/core";
import { en } from "./en.ts";
import { zhCN, type MessageCatalog, type MessageKey, type PluralForms } from "./zh-CN.ts";

export type ResolvedUiLocale = Exclude<UiLocale, "system">;
export type { MessageKey, PluralForms };

export const MESSAGE_CATALOGS: Record<ResolvedUiLocale, MessageCatalog> = {
	"zh-CN": zhCN,
	en,
};
