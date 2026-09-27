/**
 * Is this provider reachable, and how quickly.
 *
 * A one-token request rather than a models listing: what the settings page is really asking is
 * whether a real request would work, and only a real request answers that.
 */

import type { ProviderTestResult } from "./ipc-types.ts";
import { providerHeaders, type Settings } from "@lyra/core";

/**
 * Auth plus the provider's own headers, in the order the real requests send them. A probe has no
 * session, so a `{{sessionId}}` in them becomes a throwaway id — some endpoints refuse a request
 * that carries no session header at all.
 */
function requestHeaders(provider: Settings["providers"][number]): Record<string, string> {
	return {
		...(provider.api === "anthropic-messages"
			? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
			: { authorization: `Bearer ${provider.apiKey}` }),
		...providerHeaders(provider.headers, undefined),
	};
}

/**
 * Probe a provider with a one-token request. A models listing is attempted first because it
 * is free, but many relays do not expose one, so a failure there is not treated as fatal.
 */
export async function testProvider(
	provider: Settings["providers"][number],
	targetModelId?: string,
): Promise<ProviderTestResult> {
	const started = Date.now();
	const base = provider.baseUrl.replace(/\/+$/, "");
	const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

	let models: string[] | undefined;
	// Only fetch the full model catalogue if testing the provider as a whole (no specific model requested)
	if (!targetModelId) {
		try {
			const listed = await fetch(modelsUrl, {
				headers: requestHeaders(provider),
				signal: AbortSignal.timeout(15_000),
			});
			if (listed.ok) {
				const body = (await listed.json()) as { data?: { id?: string }[] };
				models = body.data?.map((m) => m.id ?? "").filter(Boolean).slice(0, 200);
			}
		} catch {
			models = undefined;
		}
	}

	const model = targetModelId
		? provider.models.find((m) => m.id === targetModelId || m.modelId === targetModelId)
		: provider.models[0];

	if (!model) {
		if (targetModelId) {
			return { ok: false, latencyMs: Date.now() - started, message: "未找到指定的模型" };
		}
		return models
			? { ok: true, latencyMs: Date.now() - started, message: `连接成功，发现 ${models.length} 个可用模型`, models }
			: { ok: false, latencyMs: Date.now() - started, message: "请先添加至少一个模型再测试" };
	}

	try {
		const isAnthropic = provider.api === "anthropic-messages";
		const response = await fetch(isAnthropic ? `${base}/v1/messages`.replace("/v1/v1/", "/v1/") : `${base}/v1/responses`.replace("/v1/v1/", "/v1/"), {
			method: "POST",
			headers: { "content-type": "application/json", ...requestHeaders(provider) },
			body: JSON.stringify(
				isAnthropic
					? { model: model.modelId, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
					: { model: model.modelId, input: "hi", max_output_tokens: 16, stream: false, store: false },
			),
			signal: AbortSignal.timeout(30_000),
		});
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			return { ok: false, latencyMs, message: `HTTP ${response.status}: ${detail}`, models };
		}
		return { ok: true, latencyMs, message: `连接成功，${model.name || model.modelId} 响应正常`, models };
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			message: error instanceof Error ? error.message : String(error),
			models,
		};
	}
}

/**
 * Fetch available model list directly from the provider's /models endpoint.
 */
export async function fetchEndpointModels(
	provider: Settings["providers"][number],
): Promise<{ ok: boolean; models: string[]; error?: string }> {
	const base = provider.baseUrl.replace(/\/+$/, "");
	const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

	try {
		const res = await fetch(modelsUrl, {
			headers: requestHeaders(provider),
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			return { ok: false, models: [], error: `HTTP ${res.status}: ${detail || "获取模型列表失败"}` };
		}

		const body = (await res.json()) as { data?: { id?: string }[] } | { models?: { id?: string; name?: string }[] } | string[];
		let modelList: string[] = [];

		if (Array.isArray(body)) {
			modelList = body.filter((m): m is string => typeof m === "string");
		} else if (body && "data" in body && Array.isArray(body.data)) {
			modelList = body.data.map((m) => m.id ?? "").filter(Boolean);
		} else if (body && "models" in body && Array.isArray(body.models)) {
			modelList = body.models.map((m) => m.id ?? m.name ?? "").filter(Boolean);
		}

		// Sort models naturally
		modelList.sort((a, b) => a.localeCompare(b));

		return { ok: true, models: modelList };
	} catch (error) {
		return {
			ok: false,
			models: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
