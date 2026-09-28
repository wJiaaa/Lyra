/**
 * What a newly imported model starts with.
 *
 * Limits, capabilities and price are filled in once from the model catalogue (`@plume/core/model-catalog`),
 * which knows the endpoint as well as the model name. After that the row is the person's: catalogue
 * updates do not touch it. A model the catalogue does not know gets the general defaults.
 *
 * The pull dialog shows the same figure the import will write, from the same function.
 */

import type { ModelConfig, ProviderConfig } from "@plume/core";
import { catalogFill, catalogModelFor, DEFAULT_MODEL_LIMITS, type CatalogFill } from "@plume/core/model-catalog";

type Endpoint = Pick<ProviderConfig, "id" | "baseUrl">;

function initialValues(provider: Pick<ProviderConfig, "baseUrl">, modelId: string): CatalogFill {
	const found = catalogModelFor(provider, modelId);
	return found ? catalogFill(found.provider.id, found.model) : DEFAULT_MODEL_LIMITS;
}

/** One discovered model id, as a row in the provider's list. */
export function importedModel(provider: Endpoint, modelId: string): ModelConfig {
	const { pricing, ...values } = initialValues(provider, modelId);
	return {
		id: `${provider.id}/${modelId}`,
		providerId: provider.id,
		modelId,
		name: modelId,
		...values,
		...(pricing ? { pricing } : {}),
	};
}

/** The context window the import will write for this model, formatted the way the model list formats it. */
export function windowLabel(provider: Pick<ProviderConfig, "baseUrl">, modelId: string): string {
	return `${Math.round(initialValues(provider, modelId).contextWindow / 1000)}K`;
}
