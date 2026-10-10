import type { ComponentType } from "react";
import { create } from "zustand";

/**
 * 环境卡片开没开、哪几节被人关掉了。
 *
 * 放在 `store/` 而不是环境那个域里：环境域（标题栏的开关、卡片）写它，对话区（`conversation`）读它
 * 来让位——跨了域。
 *
 * 开关是全窗口一个，不按会话记。按会话记的话，每开一个新会话都要再点一次才看得到它，而卡片里
 * 的东西本来就跟着会话换。存在 localStorage 而不是 settings：这是这扇窗户的摆设，不是 agent
 * 的行为，主进程用不着知道。
 */

export type EnvironmentSection = "openIn" | "jobs" | "subAgents" | "pullRequest" | "sideChats" | "summary" | "references";

export const ENVIRONMENT_SECTIONS: EnvironmentSection[] = ["openIn", "jobs", "subAgents", "pullRequest", "sideChats", "summary", "references"];

const STORAGE_KEY = "plume:environment-card";

interface Stored {
	open: boolean;
	hidden: EnvironmentSection[];
}

function read(): Stored {
	const fallback: Stored = { open: false, hidden: [] };
	if (typeof window === "undefined" || !window.localStorage) return fallback;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<Stored>;
		return {
			open: parsed.open === true,
			hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((section): section is EnvironmentSection => ENVIRONMENT_SECTIONS.includes(section)) : [],
		};
	} catch {
		return fallback;
	}
}

function write(state: Stored): void {
	if (typeof window === "undefined" || !window.localStorage) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// 存不下就只在这次窗口里生效，不影响卡片本身。
	}
}

export const useEnvironmentCard = create<Stored>(() => read());

function update(patch: Partial<Stored>): void {
	useEnvironmentCard.setState(patch);
	const { open, hidden } = useEnvironmentCard.getState();
	write({ open, hidden });
}

export function toggleEnvironmentCard(): void {
	update({ open: !useEnvironmentCard.getState().open });
}

export function setEnvironmentSectionShown(section: EnvironmentSection, shown: boolean): void {
	const hidden = useEnvironmentCard.getState().hidden.filter((entry) => entry !== section);
	update({ hidden: shown ? hidden : [...hidden, section] });
}

/*
 * 卡片本身由环境那个域在加载时登记进来，对话区从这里取。
 *
 * 对话区直接 import 卡片会连出环：卡片要用 dock、输入框，而它们一路连回对话域（`pnpm arch` 拦下的
 * 就是这个）。和 dock 的 `provideReveal` 是同一个解法。没登记过的窗口（没有标题栏开关的那些）拿到
 * null，对话区据此既不画卡片，也不让位。
 */
let card: ComponentType | null = null;

export function provideEnvironmentCard(component: ComponentType): void {
	card = component;
}

export function environmentCard(): ComponentType | null {
	return card;
}
