import type { MobileMethod } from "@plume/contract";
import type { Bootstrap } from "@plume/client-runtime";
import type { SessionStorage, Settings } from "@plume/core";
import { resolveModelThinkingOptions } from "@plume/core/thinking-options";
import { isImageModel } from "@plume/core/image-models";
import { resolveSessionApproval } from "./approval-response.ts";
import { slimSnapshot } from "./display-transcript.ts";
import { promptBlocks } from "./mobile-prompt.ts";
import { generalScratchDir } from "./scratch.ts";
import { abortSession, broadcast, createSession, disposeSession, ensureLiveSession, promptSession, sessions, snapshot, touchSession } from "./session-hub.ts";

export interface MobileRpcDeps {
	store(): SessionStorage;
	settings(): Settings;
	saveSettings(next: Settings): Promise<void>;
}

function text(value: unknown, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid input");
	return value.trim();
}

function mobileModels(settings: Settings): Bootstrap["models"] {
	// Conversation models only: an image model picked for a new chat would fail on its first request.
	return settings.providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models.filter((model) => !isImageModel(model)).map((model) => ({
		id: model.id, name: model.name, provider: provider.name, images: model.supportsImages,
		thinkingOptions: resolveModelThinkingOptions(model).map((option) => ({ value: option.id, label: option.label })),
	})));
}

export async function mobileRpc(deps: MobileRpcDeps, method: MobileMethod, args: unknown[]): Promise<unknown> {
	const settings = deps.settings();
	const store = deps.store();
	const models = mobileModels(settings);
	if (method === "bootstrap") return {
		name: "Plume", projects: settings.projects.map(({ id, name, path }) => ({ id, name, path })), models,
		defaultModelId: models.some((model) => model.id === settings.defaultModelId) ? settings.defaultModelId! : models[0]?.id ?? "", thinking: settings.thinking,
		sessions: await store.listSessions(), runningSessionIds: [...sessions.values()].filter((session) => session.running).map((session) => session.meta.id),
	} satisfies Bootstrap;
	if (method === "sessions.list") return store.listSessions();
	const id = text(args[0]);
	if (method === "sessions.create") {
		const project = settings.projects.find((entry) => entry.id === id);
		if (!project && id !== "scratch") throw new Error("Project no longer exists");
		const modelId = text(args[1]);
		if (!models.some((model) => model.id === modelId)) throw new Error("Model no longer exists");
		return createSession(project?.path ?? await generalScratchDir(), modelId);
	}
	const meta = await store.get(id);
	if (!meta) throw new Error("Session no longer exists");
	if (method === "sessions.get") {
		const live = sessions.get(id);
		if (live) { touchSession(id); return snapshot(live); }
		const loaded = await store.load(id, { display: true });
		if (!loaded) throw new Error("Session no longer exists");
		return slimSnapshot({ meta: loaded.meta, messages: loaded.messages, running: false, pendingApprovals: [], compactions: loaded.compactions, commandRuns: loaded.commandRuns, hookRuns: loaded.hookRuns });
	}
	if (method === "sessions.rename") {
		const title = text(args[1], 200);
		const live = sessions.get(id);
		if (live) { await live.rename(title); return live.meta; }
		const updated = await store.append(meta, { type: "title", title, source: "user" });
		if (updated) broadcast(id, { type: "title", title });
		return updated;
	}
	if (method === "sessions.archive") {
		if (typeof args[1] !== "boolean") throw new Error("Invalid archive flag");
		if (sessions.get(id)?.running) throw new Error("Stop the session before archiving");
		if (args[1]) await disposeSession(id, "archived");
		await store.setArchived(id, args[1]);
		return;
	}
	// 桌面端忙时先排队（Composer 的队列在渲染进程里，手机看不到），手机这边同样不插进正在跑的那一轮。
	if (method === "agent.prompt") return promptSession(id, promptBlocks(args[1], args[2]), { deliver: "followUp" });
	if (method === "agent.abort") return abortSession(id);
	if (method === "agent.approve") {
		const live = sessions.get(id);
		if (!live) throw new Error("Approval expired");
		return resolveSessionApproval(live, text(args[1]), args[2], async (subject) => {
			const current = deps.settings();
			if (!current.alwaysAllow.includes(subject)) await deps.saveSettings({ ...current, alwaysAllow: [...current.alwaysAllow, subject] });
		});
	}
	if (method === "agent.setModel") {
		const modelId = text(args[1]);
		if (!models.some((model) => model.id === modelId)) throw new Error("Model no longer exists");
		const live = await ensureLiveSession(id);
		return live?.setModel(modelId);
	}
	if (method === "agent.setThinking") {
		const value = args[1] === null ? null : text(args[1]);
		if (value !== null && !models.find((model) => model.id === meta.modelId)?.thinkingOptions.some((option) => option.value === value)) throw new Error("Invalid thinking level");
		const live = sessions.get(id);
		if (live) return live.setThinking(value);
		await store.append(meta, { type: "meta", meta: { ...meta, thinking: value ?? undefined } });
		return;
	}
	throw new Error("Unsupported method");
}
