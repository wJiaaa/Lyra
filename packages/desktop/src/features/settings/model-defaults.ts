/**
 * What a newly imported model starts with.
 *
 * Limits and capabilities come from the smart-config rules (`@lyra/core/model-rules`), which know the
 * endpoint as well as the model name: the same `glm-5.3` gets different limits on OpenCode Go than on
 * the vendor's own API. An imported row is marked `smart`, so later rule updates reach it until the
 * person pins a field in the model editor. The catalogue is still consulted, but only for price.
 *
 * The pull dialog shows the same figure the import will write, from the same function.
 */

import type { ModelConfig, ProviderConfig } from "@lyra/core";
import { withCatalogPricing } from "@lyra/core/model-catalog";
import { resolveModelRules } from "@lyra/core/model-rules";

type Endpoint = Pick<ProviderConfig, "id" | "baseUrl" | "api">;

/** One discovered model id, as a row in the provider's list. */
export function importedModel(provider: Endpoint, modelId: string): ModelConfig {
	return withCatalogPricing(provider, {
		id: `${provider.id}/${modelId}`,
		providerId: provider.id,
		modelId,
		name: modelId,
		...resolveModelRules(provider, modelId).config,
		metadataSource: "smart",
	});
}

/** The context window the import will write for this model, formatted the way the model list formats it. */
export function windowLabel(provider: Pick<ProviderConfig, "baseUrl" | "api">, modelId: string): string {
	return `${Math.round(resolveModelRules(provider, modelId).config.contextWindow / 1000)}K`;
}
