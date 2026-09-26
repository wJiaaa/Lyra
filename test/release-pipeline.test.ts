/**
 * 发版流水线里那几条「只有发版才会执行到」的约定。
 *
 * 这些约定没有一条能被普通的检查覆盖：它们要么写在 YAML 里（lint 和 tsc 都不读），要么是「同一个
 * 名字写在三个地方」，要么是「一个看起来没用的依赖其实不能删」。而它们错掉的代价都一样——tag 已
 * 经推上去了，才发现。
 *
 * 第一次发版踩到的就是这一类：Linux 不接受的 `executableName` 在仓库里躺着，日常检查全绿，
 * 直到 tag 推上去、打包那一步才红。整条链路上没有任何东西会提前说一句。
 *
 * 所以这里守的不是代码的行为，是流水线的形状。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const release = read(".github/workflows/release.yml");
const dryrun = read(".github/workflows/release-dryrun.yml");
const desktopBuild = read(".github/workflows/_desktop-build.yml");
const ci = read(".github/workflows/ci.yml");

/**
 * 每个系统每个架构都有人给它打包。
 *
 * 少一个架构不会让任何检查变红：Linux arm64 的 AppImage 从第一次发版起就不存在，而那只表现为
 * 「树莓派上点更新没反应」——`update-asset.ts` 找不到自己架构的文件时返回 null，界面说的是「已是
 * 最新」。这里守的是「谁来构建」（runner 矩阵）和「构建什么」（electron-builder 的 target），
 * 两处任意一处漏掉，都得等到有人拿着那台机器来问。
 */
test("四个 runner 覆盖三个系统的每个架构", () => {
	// macOS 与 Windows 各一台机器出两个架构（clang 带两套 slice、MSVC 带 arm64 交叉编译器）；
	// Linux 没有 aarch64 交叉工具链，所以 x64 和 arm64 各占一台。
	const expected = ["macos-latest", "windows-latest", "ubuntu-latest", "ubuntu-24.04-arm"];
	for (const runner of expected) {
		assert.ok(desktopBuild.includes(`os: ${runner}`), `_desktop-build.yml 的矩阵里没有 ${runner}`);
	}

	const artifacts = [...desktopBuild.matchAll(/artifact: (\S+)/g)].map((m) => m[1]);
	assert.deepEqual(
		artifacts,
		["mac", "win", "linux", "linux-arm64"],
		"产物名两两不同才不会在 download-artifact 的 merge-multiple 里互相覆盖",
	);
});

test("electron-builder 每个平台该出的架构都写着", () => {
	const config = read("packages/desktop/electron-builder.yml");

	/** 某个 target 下写着的架构，顺序无关。 */
	const arches = (target: string) => {
		const found = new RegExp(`- target: ${target}\\n\\s+arch: \\[([^\\]]+)\\]`).exec(config);
		return found ? found[1].split(",").map((one) => one.trim()).sort() : null;
	};

	// mac 与 win 明写两个架构。
	for (const target of ["dmg", "zip", "nsis"]) {
		assert.deepEqual(arches(target), ["arm64", "x64"], `${target} 少了一个架构——发版会少一个包，而没有任何检查会红`);
	}

	// Linux 故意不写，靠宿主架构，两台 runner 各出自己的那个；写上它就意味着 x64 那台要交叉
	// 编译 arm64 的 node-pty，而那个工具链不在镜像里。只看 YAML 的键，注释里怎么说不算。
	const lines = config.split("\n");
	const start = lines.indexOf("linux:");
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && line !== "linux:");
	const linuxKeys = lines.slice(start, end === -1 ? undefined : end).filter((line) => !line.trim().startsWith("#"));

	assert.ok(start !== -1, "electron-builder.yml 里没有 linux 段落");
	assert.deepEqual(
		linuxKeys.filter((line) => /^\s*arch:/.test(line)),
		[],
		"linux 段落不该有 arch 键：两个架构由两台 runner 各自的宿主架构决定",
	);
	for (const target of ["- AppImage", "- deb"]) {
		assert.ok(linuxKeys.some((line) => line.trim() === target), `linux 的 target 里少了 ${target}`);
	}

	// 打完包读回产物架构的那张表，也要认得这两台 Linux。
	const archCheck = read("packages/desktop/scripts/check-native-arch.mjs");
	for (const dir of ["linux-unpacked", "linux-arm64-unpacked"]) {
		assert.ok(archCheck.includes(dir), `check-native-arch.mjs 不认识 ${dir}，那台 runner 的产物就没人验架构`);
	}
});

test("排练和发版调用同一个桌面端构建工作流", () => {
	for (const [name, workflow] of [["release.yml", release], ["release-dryrun.yml", dryrun]] as const) {
		assert.match(
			workflow,
			/uses: \.\/\.github\/workflows\/_desktop-build\.yml/,
			`${name} 没有调用 _desktop-build.yml——排练与发版必须跑同一份文件，否则排练不再排练它要排练的东西`,
		);
	}
});

test("签名要求：发版致命，排练只警告", () => {
	const values = (workflow: string) => [...workflow.matchAll(/require-signing: (true|false)/g)].map((m) => m[1]);

	assert.deepEqual(values(release), ["true"], "release.yml 必须 require-signing: true");
	assert.deepEqual(values(dryrun), ["false"], "排练里该是 false，否则没有密钥的排练会红");
});

test("排练红了不能假装绿", () => {
	assert.match(
		read("scripts/release.mjs"),
		/--exit-status/,
		"rehearse 若不看 exit-status，红的 dry run 也会打印「绿了就可以」并退出 0",
	);
});

test("all-green 等 windows-ui 也等 knip，pre-push 跑同一组 check", () => {
	const hook = read("lefthook.yml");
	assert.match(ci, /needs: \[[^\]]*windows-ui[^\]]*\]/, "all-green 不等 windows-ui，Windows 窗口红了主分支仍是绿的");
	assert.match(ci, /needs: \[[^\]]*dead-code[^\]]*\]/, "all-green 不等 knip，未用导出可以进 main");
	assert.match(hook, /pnpm check/, "pre-push 只跑 typecheck/test 时，lint 和 i18n 要到 CI 才爆");
	assert.match(hook, /pnpm knip/, "pre-push 不跑 knip，未用导出同样要到 CI 才爆");
	const run = /windows-ui:[\s\S]*?run: pnpm --filter @lyra\/desktop exec node --test[^\n]+/.exec(ci)?.[0] ?? "";
	for (const file of run.match(/e2e\/[\w.-]+\.test\.ts/g) ?? []) {
		assert.ok(
			readFileSync(join(root, "packages/desktop", file), "utf8").length > 0,
			`windows-ui 还点着 ${file}，文件却不在了`,
		);
	}
});
