/**
 * Asking the web a question, without the tool knowing who answers it.
 *
 * Search services are the part of this that will change: one gets an API, one gets a paywall, one
 * turns out to return better results for code. What must not change when they do is how the model
 * asks — so the model-facing tool is one thing, the providers are another, and this is the seam
 * between them.
 *
 * The shape follows what the reference implementation arrived at after three genuinely different
 * backends (a search API, a chat model with citations, a model with a native search tool). Two
 * details of it are load-bearing:
 *
 * `available()` is a **local** check — is there a key, does the config parse — and must not touch
 * the network. Selection happens on every call, and a selection that made an HTTP request would
 * put a probe in front of every search.
 *
 * Selection never depends on registration order. A configured id wins; otherwise a provider that
 * needed a key beats one that did not, a lone keyless default beats nothing at all, and a genuine
 * tie is an error rather than a coin toss. "Whichever plugin loaded first" is not a decision
 * anybody made.
 */

export interface SearchSource {
	url: string;
	title?: string;
	snippet?: string;
	/** Publication or crawl time, as the provider spelled it. */
	publishedAt?: string;
}

export interface SearchResult {
	/**
	 * A generated answer, when the provider makes one.
	 *
	 * Some do (a chat model with citations), some do not (a plain search API). Optional rather
	 * than invented: an empty summary is honest, a fabricated one is not.
	 */
	content?: string;
	sources: SearchSource[];
	/** Set when the seam cut the list down to `maxResults`. */
	truncated: boolean;
}

export interface SearchRequest {
	query: string;
	/**
	 * Upper bound on sources, enforced by the seam on the way back.
	 *
	 * Deliberately not a model-facing argument. It is a cost and context-budget decision that
	 * belongs to whoever configured the app, and a model asking for fifty results is describing a
	 * budget it cannot see.
	 */
	maxResults?: number;
	signal?: AbortSignal;
}

export interface SearchProvider {
	/** Registry key, and what a config points at. */
	id: string;
	/** Human-facing name for settings. */
	name: string;
	/**
	 * Whether this provider could run right now — key present, config parseable.
	 *
	 * Local only. No network.
	 */
	available(): boolean;
	/**
	 * Set on a provider that works with nothing configured, to say how it enters the running.
	 *
	 * `"default"` is the one a fresh install searches with. `"optional"` is available the moment
	 * somebody picks it and is never picked on their behalf. Only a provider that needs no key
	 * carries this: a key on disk is a decision somebody made, and working without one is not.
	 */
	keyless?: "default" | "optional";
	search(request: SearchRequest): Promise<SearchResult>;
}

/** Why a search could not run. Open on purpose: a provider may raise its own codes. */
export class SearchError extends Error {
	readonly code: string;
	constructor(message: string, code: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SearchError";
		this.code = code;
	}
}

const providers = new Map<string, SearchProvider>();

/** Register one provider. Returns the disposer, so a plugin can take it back. */
export function registerSearchProvider(provider: SearchProvider): () => void {
	if (providers.has(provider.id)) {
		throw new SearchError(`搜索提供方 ${provider.id} 已经注册过了`, "SEARCH_DUPLICATE_PROVIDER");
	}
	/*
	 * Two defaults would put selection back where it started: the answer depending on which one
	 * loaded first. Caught at registration rather than at the first search, because it is a mistake
	 * in the registration list that nobody can configure their way out of.
	 */
	if (provider.keyless === "default" && [...providers.values()].some((known) => known.keyless === "default")) {
		throw new SearchError(`默认的免配置搜索提供方已经有一个了，${provider.id} 不能也是默认`, "SEARCH_DUPLICATE_DEFAULT");
	}
	providers.set(provider.id, provider);
	return () => {
		providers.delete(provider.id);
	};
}

/** Every registered provider, for settings to list. */
export function searchProviders(): SearchProvider[] {
	return [...providers.values()];
}

/** Forget all of them. Tests only. */
export function resetSearchProviders(): void {
	providers.clear();
}

/**
 * The provider one search will use.
 *
 * Every failure is its own code, because the fixes are different: a name that is not registered is
 * a typo, a name that is registered but unusable is a missing key, and a tie between two things
 * somebody configured is a choice that has not been made yet.
 */
export function selectSearchProvider(configuredId?: string | null): SearchProvider {
	if (configuredId) {
		const chosen = providers.get(configuredId);
		if (!chosen) throw new SearchError(`没有注册过叫 ${configuredId} 的搜索提供方`, "SEARCH_PROVIDER_MISSING");
		if (!chosen.available()) {
			throw new SearchError(`搜索提供方 ${configuredId} 还不能用（多半是没填 key）`, "SEARCH_PROVIDER_UNAVAILABLE");
		}
		return chosen;
	}
	const usable = [...providers.values()].filter((provider) => provider.available());
	if (usable.length === 0) throw new SearchError("没有可用的搜索提供方", "SEARCH_PROVIDER_UNAVAILABLE");
	if (usable.length === 1) return usable[0];

	/*
	 * A key on disk is a decision; a provider that works without one is not.
	 *
	 * So the keyed ones are asked about first: somebody who pasted a key without also clicking a
	 * radio meant to use it, and answering that with the built-in default would quietly ignore what
	 * they set up. Two pasted keys is a question only they can answer — which is the case this
	 * branch was written for in the first place.
	 */
	const configured = usable.filter((provider) => provider.keyless === undefined);
	if (configured.length === 1) return configured[0];
	if (configured.length > 1) throw ambiguous(configured);

	/*
	 * Nothing was configured here, so no setup is being overruled and the default answers. With no
	 * default registered there is nothing left to do but ask, which is what a host that registers
	 * several optional providers gets.
	 */
	const fallback = usable.filter((provider) => provider.keyless === "default");
	if (fallback.length === 1) return fallback[0];
	throw ambiguous(usable);
}

/** The one failure whose fix is a decision rather than a setting, and it names the candidates. */
function ambiguous(candidates: SearchProvider[]): SearchError {
	const ids = candidates.map((provider) => provider.id).join("、");
	return new SearchError(`有多个可用的搜索提供方（${ids}），请在设置里指定用哪个`, "SEARCH_PROVIDER_AMBIGUOUS");
}

/**
 * Run one search through the selected provider, and hold it to the bound.
 *
 * The truncation is here rather than trusted to each provider: a bound that every adapter has to
 * remember is one that some adapter will not.
 */
export async function search(request: SearchRequest, configuredId?: string | null): Promise<SearchResult> {
	const provider = selectSearchProvider(configuredId);
	const result = await provider.search(request);
	const limit = request.maxResults;
	if (limit !== undefined && result.sources.length > limit) {
		return { ...result, sources: result.sources.slice(0, limit), truncated: true };
	}
	return result;
}
