import type { UiLocale } from "@lyra/core";
import type { MessageKey, ResolvedUiLocale } from "./messages/index.ts";

export interface LocaleOption {
	value: UiLocale;
	mark: string;
	label: MessageKey;
}

export const LOCALE_OPTIONS: readonly LocaleOption[] = [
	{ value: "system", mark: "Aa", label: "language.system" },
	{ value: "zh-CN", mark: "中", label: "language.zh-CN" },
	{ value: "en", mark: "EN", label: "language.en" },
];

export function resolveUiLocale(locale: UiLocale, languages: readonly string[]): ResolvedUiLocale {
	if (locale !== "system") return locale;
	for (const language of languages) {
		const matched = matchLanguage(language);
		if (matched) return matched;
	}
	return "en";
}

function matchLanguage(language: string): ResolvedUiLocale | null {
	const normalized = language.trim().replaceAll("_", "-").toLowerCase();
	if (!normalized) return null;
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	return null;
}
