/**
 * 模型目录的拉取与缓存。
 *
 * 唯一的来源是 pi 的公开目录。桌面主进程启动时先读缓存，之后定时拉一次，设置页也能手动触发。
 * 带上次的 ETag 做条件请求，没变时服务器回 304，不重复下载近 1MB 的原始数据。拉到的内容压成
 * Lyra 用得到的几项、整份校验，比当前的新才换上，并缓存到 `~/.lyra/model-catalog.json`。任何一步
 * 失败都保持现有目录——打包的快照只在首次启动和离线时兜底。
 */

import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { activeModelCatalog, installModelCatalog } from "./model-catalog.ts";
import { compactPiCatalog, isRecord, MODEL_CATALOG_URL, parseModelCatalog, type ModelCatalogDocument } from "./model-catalog-format.ts";

export { MODEL_CATALOG_URL } from "./model-catalog-format.ts";
import { lyraHome } from "./session/store.ts";
import { writeFileAtomic } from "./utils/atomic-write.ts";

/** 自动同步的间隔。目录变化以天计，一小时一次足够及时；没变时只是一个 304。 */
export const MODEL_CATALOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;

interface CachedCatalog {
	etag?: string;
	document: ModelCatalogDocument;
}

export interface CatalogSyncResult {
	status: "updated" | "unchanged" | "failed";
	/** 失败原因，给设置页显示。 */
	error?: string;
	source: ModelCatalogDocument["source"];
}

function cachePath(): string {
	return join(lyraHome(), "model-catalog.json");
}

async function readCache(): Promise<CachedCatalog | null> {
	try {
		const cached: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
		if (!isRecord(cached)) return null;
		return { etag: typeof cached.etag === "string" ? cached.etag : undefined, document: parseModelCatalog(cached.document) };
	} catch {
		return null;
	}
}

/** 启动时换上上次缓存的目录。没有或坏了就当没有。返回是否换上了。 */
export async function loadCachedModelCatalog(): Promise<boolean> {
	const cached = await readCache();
	return cached ? installModelCatalog(cached.document) : false;
}

/**
 * 拉一次目录。`updated` 表示换上了新目录——调用方据此把设置重新套一遍目录值。
 *
 * 不抛：网络不通、非 200、内容不合法都返回 `failed` 和原因，现有目录不动。
 */
export async function syncModelCatalog(
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<CatalogSyncResult> {
	const failed = (error: string): CatalogSyncResult => ({ status: "failed", error, source: activeModelCatalog().source });
	try {
		const cached = await readCache();
		// ETag 只在那份缓存正是当前生效的目录时才用：否则一个 304 会让缓存坏掉之后永远拉不到新的。
		const etag = cached?.document.source.revision === activeModelCatalog().source.revision ? cached.etag : undefined;
		const response = await (options.fetch ?? globalThis.fetch)(MODEL_CATALOG_URL, {
			headers: { accept: "application/json", "user-agent": "Lyra", ...(etag ? { "if-none-match": etag } : {}) },
			signal: options.signal ?? AbortSignal.timeout(30_000),
		});
		if (response.status === 304) return { status: "unchanged", source: activeModelCatalog().source };
		if (!response.ok) return failed(`HTTP ${response.status}`);
		const text = await response.text();
		const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
		const document = compactPiCatalog(JSON.parse(text), {
			name: "pi.dev",
			url: MODEL_CATALOG_URL,
			revision: response.headers.get("x-pi-model-catalog-revision") ?? `sha256-${createHash("sha256").update(text).digest("hex")}`,
			updatedAt: new Date(Number.isNaN(lastModified) ? Date.now() : lastModified).toISOString(),
		});
		const updated = installModelCatalog(document);
		const cache: CachedCatalog = { etag: response.headers.get("etag") ?? undefined, document: updated ? document : activeModelCatalog() };
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFileAtomic(cachePath(), JSON.stringify(cache)).catch(() => undefined);
		return { status: updated ? "updated" : "unchanged", source: activeModelCatalog().source };
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}
