/**
 * 模型目录的远程同步：新目录换上并缓存，ETag 命中回 304，失败不动现有目录，重启读缓存。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { activeModelCatalog, resetModelCatalog } from "../src/model-catalog.ts";
import { loadCachedModelCatalog, MODEL_CATALOG_URL, syncModelCatalog } from "../src/model-catalog-sync.ts";

const RAW = {
	openai: {
		"gpt-5.2": { id: "gpt-5.2", name: "GPT-5.2", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"], cost: { input: 1, output: 2 }, contextWindow: 400_000, maxTokens: 128_000 },
	},
};

interface Call {
	url: string;
	headers: Record<string, string>;
}

function server(respond: (call: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(url), headers: { ...(init?.headers as Record<string, string>) } };
		calls.push(call);
		return respond(call);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function catalogResponse(revision = "rev-remote", etag = '"etag-1"'): Response {
	return new Response(JSON.stringify(RAW), {
		status: 200,
		headers: { etag, "x-pi-model-catalog-revision": revision, "last-modified": "Wed, 01 Jan 2099 00:00:00 GMT" },
	});
}

describe("model catalogue sync", () => {
	let home: string;
	let previousHome: string | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "lyra-catalog-"));
		previousHome = process.env.LYRA_HOME;
		process.env.LYRA_HOME = home;
		resetModelCatalog();
	});

	afterEach(async () => {
		if (previousHome === undefined) delete process.env.LYRA_HOME;
		else process.env.LYRA_HOME = previousHome;
		resetModelCatalog();
		await rm(home, { recursive: true, force: true });
	});

	it("installs a newer catalogue, caches it, and survives a restart", async () => {
		const remote = server(() => catalogResponse());
		const result = await syncModelCatalog({ fetch: remote.fetch });
		assert.equal(result.status, "updated");
		assert.equal(remote.calls[0].url, MODEL_CATALOG_URL);
		assert.equal(remote.calls[0].headers["if-none-match"], undefined, "no cache yet");
		assert.deepEqual(result.source, { name: "pi.dev", url: MODEL_CATALOG_URL, revision: "rev-remote", updatedAt: "2099-01-01T00:00:00.000Z" });
		assert.equal(activeModelCatalog().providers[0].models[0].contextWindow, 400_000);

		resetModelCatalog();
		assert.equal(await loadCachedModelCatalog(), true);
		assert.equal(activeModelCatalog().source.revision, "rev-remote");
	});

	it("revalidates with the cached ETag and treats 304 as unchanged", async () => {
		await syncModelCatalog({ fetch: server(() => catalogResponse()).fetch });
		const remote = server(() => new Response(null, { status: 304 }));
		const result = await syncModelCatalog({ fetch: remote.fetch });
		assert.equal(result.status, "unchanged");
		assert.equal(remote.calls[0].headers["if-none-match"], '"etag-1"');
		assert.equal(activeModelCatalog().source.revision, "rev-remote");
	});

	it("drops the ETag when the cache is not the active catalogue, so a 304 cannot pin a stale one", async () => {
		await syncModelCatalog({ fetch: server(() => catalogResponse()).fetch });
		resetModelCatalog();
		const remote = server(() => catalogResponse());
		assert.equal((await syncModelCatalog({ fetch: remote.fetch })).status, "updated");
		assert.equal(remote.calls[0].headers["if-none-match"], undefined);
	});

	it("reports failures and keeps the active catalogue", async () => {
		const before = activeModelCatalog().source.revision;
		for (const respond of [
			() => new Response("nope", { status: 503 }),
			() => new Response("{not json", { status: 200 }),
			() => new Response(JSON.stringify({}), { status: 200 }),
			() => { throw new Error("offline"); },
		]) {
			const result = await syncModelCatalog({ fetch: server(respond).fetch });
			assert.equal(result.status, "failed");
			assert.ok(result.error);
			assert.equal(activeModelCatalog().source.revision, before);
		}
	});

	it("ignores a corrupt cache", async () => {
		await writeFile(join(home, "model-catalog.json"), "{broken");
		assert.equal(await loadCachedModelCatalog(), false);
		await syncModelCatalog({ fetch: server(() => catalogResponse()).fetch });
		assert.equal(JSON.parse(await readFile(join(home, "model-catalog.json"), "utf8")).etag, '"etag-1"');
	});
});
