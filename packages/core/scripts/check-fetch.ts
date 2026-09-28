/**
 * The four ways a bundle can arrive, checked against the real network.
 *
 * `fetchBundle` prefers a verified archive and falls back to cloning. Every branch of that has to
 * work, and three of them are failure paths — which is exactly the code that never runs in normal
 * use and is therefore never noticed when it breaks.
 *
 * Needs network, so it is a script rather than a test:
 *
 *     node --experimental-strip-types scripts/check-fetch.ts
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBundle } from "../src/plugins/fetch-bundle.ts";

const URL_ = "https://codeload.github.com/kittors/Lyra-Plugins/tar.gz/main";
const base = { id: "probe", name: "Probe", kind: "plugin" as const, repository: "https://github.com/kittors/Lyra-Plugins.git" };

// 先算出这份归档真实的 sha256，后面用它做正例
const real = createHash("sha256").update(new Uint8Array(await (await fetch(URL_)).arrayBuffer())).digest("hex");
console.log(`上游归档 sha256 = ${real.slice(0, 16)}…\n`);

async function attempt(label: string, entry: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "plume-fetch-"));
	try {
		const r = await fetchBundle({ ...base, ...entry } as never, join(dir, "staging"));
		const files = readdirSync(join(dir, "staging"));
		console.log(`  ${label}`);
		console.log(`    走了 ${r.via}${r.fellBackBecause ? `（回退原因：${r.fellBackBecause}）` : ""}`);
		console.log(`    落盘 ${files.length} 项：${files.slice(0, 4).join(", ")}`);
	} catch (e) {
		console.log(`  ${label}\n    ❌ ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("① 有 tarball 且 sha256 正确 → 应当走 tarball，不碰 git");
await attempt("正例", { tarball: URL_, sha256: real });

console.log("\n② sha256 不符 → 必须拒绝这份下载，回退 git");
await attempt("哈希不符", { tarball: URL_, sha256: "a".repeat(64) });

console.log("\n③ tarball 地址是 404 → 回退 git");
await attempt("下载失败", { tarball: "https://codeload.github.com/kittors/nope-nope/tar.gz/main", sha256: real });

console.log("\n④ 完全没有 tarball → 直接 git（老索引的行为不变）");
await attempt("无 tarball", {});
