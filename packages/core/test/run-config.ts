/**
 * A run config for tests: the four groups, every field a test does not mention set to "not given".
 *
 * `src/` states every field so a forgotten one fails to compile; tests are not type-checked, so
 * spelling the groups out here would only be noise. Each group is merged over its defaults, `env`
 * one level deeper, so a test names exactly what it is about.
 */

import type {
	AgentControlContext,
	AgentModelContext,
	AgentRunConfig,
	AgentSessionContext,
	AgentToolContext,
	ToolEnvironment,
} from "../src/agent/run-config.ts";
import type { ModelConfig, ProviderConfig } from "../src/types.ts";

export const TEST_MODEL: ModelConfig = {
	id: "m",
	modelId: "m",
	providerId: "p",
	name: "m",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

export const TEST_PROVIDER: ProviderConfig = {
	id: "p",
	name: "p",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "",
	enabled: true,
	models: [TEST_MODEL],
};

export interface RunConfigParts {
	session?: Partial<AgentSessionContext>;
	model?: Partial<AgentModelContext>;
	tools?: Partial<Omit<AgentToolContext, "env">> & { env?: Partial<ToolEnvironment> };
	control?: Partial<AgentControlContext>;
}

export function runConfig(parts: RunConfigParts = {}): AgentRunConfig {
	return {
		session: {
			sessionId: "s",
			systemPrompt: "",
			messages: [],
			state: undefined,
			environment: false,
			compact: undefined,
			pruner: undefined,
			artifacts: undefined,
			...parts.session,
		},
		model: {
			provider: TEST_PROVIDER,
			model: TEST_MODEL,
			liveModel: undefined,
			thinking: undefined,
			cacheKey: undefined,
			retryPolicy: undefined,
			streamFn: undefined,
			onContext: undefined,
			...parts.model,
		},
		tools: {
			available: [],
			requestApproval: undefined,
			beforeToolCall: undefined,
			afterToolCall: undefined,
			permissionRequest: undefined,
			...parts.tools,
			env: {
				cwd: "/tmp",
				sandboxMode: undefined,
				sandboxNetwork: undefined,
				allowedHosts: undefined,
				searchProviderId: undefined,
				allowedPaths: undefined,
				projectRoots: undefined,
				spawnSubAgent: undefined,
				resources: undefined,
				scratchDir: undefined,
				writePreview: undefined,
				transcript: undefined,
				...parts.tools?.env,
			},
		},
		control: {
			signal: undefined,
			drainSteering: undefined,
			onStop: undefined,
			repetition: undefined,
			...parts.control,
		},
	};
}
