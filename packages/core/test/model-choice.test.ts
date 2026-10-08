/**
 * Model references: what a definition's `model` resolves to here, and what happens when it names
 * nothing this machine has.
 *
 * The failure worth designing against is a shared agent definition that names a model the person
 * who installed it does not have. Falling through to the session's model is deliberate — a
 * definition listing three preferences, none available, should still run rather than fail on a
 * preference.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProfile, compactionModel, withAgentProfile, parseModelRef, resolveModelRef } from "../src/config/model-choice.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { ModelConfig, ProviderConfig } from "../src/types.ts";

function model(id: string): ModelConfig {
	return {
		id,
		providerId: "p",
		modelId: id.split("/").pop()!,
		name: id,
		contextWindow: 100_000,
		maxOutputTokens: 4096,
		supportsThinking: true,
		supportsImages: false,
		supportsTools: true,
	};
}

const PROVIDER: ProviderConfig = {
	id: "p",
	name: "P",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [model("p/big"), model("p/small"), model("p/other-family"), model("p/kimi:256k")],
};

/** Models picked the way the settings page picks them: a profile under the agent's name. */
function settings(profiles: Record<string, string> = {}): Settings {
	const subAgentProfiles = Object.fromEntries(Object.entries(profiles).map(([name, modelId]) => [name, { modelId }]));
	return { ...DEFAULT_SETTINGS, providers: [PROVIDER], mcpServers: [], subAgentProfiles };
}

const FALLBACK = { provider: PROVIDER, model: model("p/session") };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a thinking suffix is split off", () => {
	assert.deepEqual(parseModelRef("p/big"), { id: "p/big" });
	assert.deepEqual(parseModelRef("p/big:low"), { id: "p/big", thinking: "low" });
});

test("a colon inside a model id is not a thinking suffix", () => {
	/*
	 * `kimi-k3:256k` is a real id on this machine. Taking every colon as a suffix would turn a
	 * valid model into one that cannot be found, which surfaces as a sub-agent silently running on
	 * the wrong model.
	 */
	assert.deepEqual(parseModelRef("p/kimi:256k"), { id: "p/kimi:256k" });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("a model that no longer exists falls through to the session's model", () => {
	/*
	 * A provider can be removed after a model was picked. Failing the run over it would break the
	 * job for a preference, so it continues on the session's model.
	 */
	assert.equal(resolveModelRef(settings({}), "p/deleted", FALLBACK).model.id, "p/session");
});

test("a list is tried in order, and the first that exists wins", () => {
	const resolved = resolveModelRef(settings({}), ["p/missing", "p/big"], FALLBACK);
	assert.equal(resolved.model.id, "p/big");
	assert.equal(resolved.via, "p/big");
});

test("no reference at all is the session's model", () => {
	assert.equal(resolveModelRef(settings({}), undefined, FALLBACK).model.id, "p/session");
	assert.equal(resolveModelRef(settings({}), null, FALLBACK).model.id, "p/session");
	assert.equal(resolveModelRef(settings({}), "", FALLBACK).model.id, "p/session");
});

test("the thinking suffix survives resolution", () => {
	const resolved = resolveModelRef(settings({}), "p/big:high", FALLBACK);
	assert.equal(resolved.model.id, "p/big");
	assert.equal(resolved.thinking, "high");
});

test("compaction uses the compact row, or the caller's model when it is unset or gone", () => {
	assert.equal(compactionModel(settings({ compact: "p/small" }), FALLBACK).model.id, "p/small");
	assert.equal(compactionModel(settings({}), FALLBACK).model.id, "p/session");
	assert.equal(compactionModel(settings({ compact: "p/deleted" }), FALLBACK).model.id, "p/session");
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

test("saving a profile replaces it, and clearing it removes only that one", () => {
	const old = settings({ simple: "p/small", compact: "p/big" });
	const next = withAgentProfile(old, "simple", { modelId: "p/big", thinking: "high" });
	assert.deepEqual(agentProfile(next, "simple"), { modelId: "p/big", thinking: "high" });
	const cleared = withAgentProfile(next, "simple", {});
	assert.deepEqual(agentProfile(cleared, "simple"), {});
	assert.equal(agentProfile(cleared, "compact").modelId, "p/big");
});
