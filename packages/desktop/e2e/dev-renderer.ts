/**
 * 渲染进程的开发服务器，给要在开发构建里验的用例用。
 *
 * 不用 electron-vite 的 `createServer`：它起完服务器一定会顺手再起一个 Electron，而用例要的是
 * `startApp` 起的那一个——自己的 profile、自己的调试端口。所以只借它解析配置，服务器用 Vite 自己起，
 * 和 `pnpm dev` 加载的是同一份渲染进程配置。主进程和 preload 仍然用 `out/` 里构建好的。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { createServer } from "vite";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

export async function startDevRenderer(): Promise<{ url: string; close: () => Promise<void> }> {
	/*
	 * 配置里的 `resolve("src")`、`root: "."` 都按工作目录算。从仓库根目录跑，`@` 别名和 index.html 全指错，
	 * 窗口一直白屏，等到 `startApp` 的 90 秒超时才报一句「shell never rendered」。在这里先说清楚。
	 */
	if (process.cwd() !== ROOT) throw new Error(`开发服务器要在 ${ROOT} 下起，现在在 ${process.cwd()}：用 pnpm --filter @plume/desktop exec 跑`);
	const resolved = await resolveConfig({ root: ROOT, logLevel: "warn" }, "serve", "development");
	const renderer = resolved.config?.renderer;
	if (!renderer) throw new Error("electron.vite.config.ts has no renderer config");
	// 端口让出来：跑用例的人多半自己还开着 `pnpm dev`，占着 5173。
	const server = await createServer({ ...renderer, server: { ...renderer.server, port: 0 } });
	await server.listen();
	const url = server.resolvedUrls?.local[0];
	if (!url) {
		await server.close();
		throw new Error("the renderer dev server did not report an address");
	}
	return { url, close: () => server.close() };
}
