import assert from "node:assert/strict";
import { test } from "node:test";
import { testProvider } from "../electron/providers.ts";
import type { ProviderConfig } from "@plume/core";

test("testProvider with targetModelId targets the specific model without fetching /models", async () => {
	let requestedUrl = "";
	let requestBody = "";

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requestedUrl = url.toString();
		requestBody = (init?.body as string) || "";
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: "ok" } }],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;

	try {
		const config: ProviderConfig = {
			id: "prov-1",
			name: "Test Relay",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-test",
			api: "responses",
			models: [
				{
					id: "m-1",
					name: "GPT 4o",
					modelId: "gpt-4o",
					contextWindow: 128000,
					maxOutputTokens: 4096,
				},
				{
					id: "m-2",
					name: "Claude Sonnet",
					modelId: "claude-3-5-sonnet",
					contextWindow: 200000,
					maxOutputTokens: 8192,
				},
			],
		};

		const result = await testProvider(config, "m-2");
		assert.equal(result.ok, true);
		assert.equal(requestedUrl, "https://api.example.com/v1/responses");
		const parsed = JSON.parse(requestBody);
		assert.equal(parsed.model, "claude-3-5-sonnet");
		assert.equal(result.models, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("testProvider fails gracefully if specified model is not configured in provider", async () => {
	const config: ProviderConfig = {
		id: "prov-1",
		name: "Test Relay",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-test",
		api: "responses",
		models: [],
	};

	const result = await testProvider(config, "non-existent-id");
	assert.equal(result.ok, false);
	assert.match(result.message, /未找到指定的模型/);
});
