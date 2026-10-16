/**
 * 把 `native/screen-capture.swift` 编成 arm64 + x86_64 通用二进制，放进 `vendor/screen-capture/`。
 *
 * 安装包从那里带走它（`electron-builder.yml` 的 mac `extraResources`），开发时主进程直接用那里的
 * 一份（`electron/screen-capture-helper.ts`）。为什么要有这个小程序，见 ADR-0052。
 *
 * 一份通用二进制而不是按架构各编一份：编译只有几秒，arm64 与 x64 两个安装包拿同一个文件，
 * `check-native-arch.mjs` 认 `universal`，不会出现「两个包都拿了本机那份」那种错。
 *
 * 部署目标是 macOS 12，和 Electron 一致：程序在 15.2 以下照样能启动，只是回 `supported:false`，
 * 主进程于是退回 desktopCapturer。
 *
 * 用法：
 *   node scripts/build-screen-capture.mjs              编一份（已是最新就跳过）
 *   node scripts/build-screen-capture.mjs --optional   postinstall 用：不是 macOS 或没有 swiftc 时只提示
 * 打包时由 `scripts/before-pack.mjs` 调用，失败就让打包失败。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../native/screen-capture.swift", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../vendor/screen-capture/", import.meta.url));
export const SCREEN_CAPTURE_BINARY = "plume-screen-capture";

/** 编好的通用二进制路径；比源文件新就不再编。 */
export function buildScreenCapture() {
	if (process.platform !== "darwin") throw new Error("[screen-capture] 只能在 macOS 上编译");
	const out = join(OUT_DIR, SCREEN_CAPTURE_BINARY);
	if (existsSync(out) && statSync(out).mtimeMs >= statSync(SOURCE).mtimeMs) return out;

	const work = mkdtempSync(join(tmpdir(), "plume-screen-capture-"));
	try {
		const slices = ["arm64", "x86_64"].map((arch) => {
			const slice = join(work, arch);
			console.log(`[screen-capture] swiftc ${arch}`);
			// Swift 5 语言模式：这几十行用不上严格并发检查，Swift 6 模式下它们只是噪音。
			execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", `${arch}-apple-macos12.0`, "-o", slice, SOURCE], {
				stdio: "inherit",
			});
			return slice;
		});
		mkdirSync(OUT_DIR, { recursive: true });
		execFileSync("xcrun", ["lipo", "-create", "-output", out, ...slices], { stdio: "inherit" });
		chmodSync(out, 0o755);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const optional = process.argv.includes("--optional");
	if (process.platform !== "darwin") {
		if (!optional) throw new Error("[screen-capture] 只能在 macOS 上编译");
	} else {
		try {
			console.log(`[screen-capture] ${buildScreenCapture()}`);
		} catch (error) {
			if (!optional) throw error;
			// 开发机没装 Xcode 命令行工具也要能 `pnpm install`：截图照样能用，只是退回 desktopCapturer。
			console.warn(`[screen-capture] 没有编出来，截图会退回 desktopCapturer（窗口没有阴影）：${error instanceof Error ? error.message : error}`);
		}
	}
}
