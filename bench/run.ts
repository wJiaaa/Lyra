/**
 * 在 Terminal-Bench 2.1 上跑 Plume。
 *
 * 判分是题目自带的 verifier，不是谁的意见：每道题一个容器，跑完由测试脚本判过或不过。
 * 这里只做四件事——打包 CLI、备齐 Harbor 和题目、把一个模型的设置交给容器、启动 `harbor run`。
 * 用法和怎么读结果见 bench/README.md。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../packages/core/src/config/settings.ts";
import type { ThinkingLevel } from "../packages/core/src/types/provider.ts";
import { fetchRipgrep } from "../packages/desktop/scripts/fetch-ripgrep.mjs";

const ROOT = join(import.meta.dirname, "..");
const CACHE = process.env.PLUME_EVAL_CACHE || join(homedir(), ".cache", "plume-eval");
const STAGE = join(CACHE, "stage");
const BUNDLE = join(CACHE, "bundle");
const HARBOR = join(CACHE, "venv", "bin", "harbor");
const TASKS = join(CACHE, "tb-2.1");
// 和 maka 公布 Terminal-Bench 2.1 成绩时锁定的是同一版 Harbor、同一个题目提交，两边的数才能放在一起看。
const HARBOR_VERSION = "0.20.0";
const TB_REPO = "https://github.com/harbor-framework/terminal-bench-2-1";
const TB_COMMIT = "d49e28f1e4ddd13d289e85a5f312a66750951932";
// 之前几轮让 Harbor 装 @latest 装上的就是这一版，锁住它，前后几轮的对照组才是同一个 opencode。
const OPENCODE_VERSION = "1.19.0";
const ARCHES = ["x64", "arm64"] as const;
type Arch = (typeof ARCHES)[number];

const USAGE = `用法：pnpm bench --model <模型 id> [--thinking <档位>] [--agent opencode --opencode-provider <供应商>] [-- <harbor run 的参数>]

  --model              桌面端设置里的模型 id，形如 provider-xxx/deepseek-flash
  --thinking           思考档位；不写就用桌面端当前的
  --agent opencode     跑对照组：同一个模型、同一个 key 交给 opencode
  --opencode-provider  opencode 认的供应商名，例如 deepseek、opencode-go
  --opencode-key-env   opencode 读 key 的变量名；不写就是供应商名第一段大写加 _API_KEY
  -- 之后             原样交给 harbor run，例如 -i 'fix-git' -n 4 -l 5

结果在 ${join(CACHE, "jobs")}`;

function run(command: string, args: string[], cwd?: string): void {
	execFileSync(command, args, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
}

/** 每次都重新打：几秒钟的事，换来的是跑的一定是当前工作区里的代码。 */
function bundleCli(): void {
	mkdirSync(STAGE, { recursive: true });
	// 根目录不直接依赖 esbuild，借桌面端构建链里那份——这里只是把 CLI 打成一个文件，版本无所谓。
	run(join(ROOT, "packages/desktop/node_modules/.bin/esbuild"), [
		join(ROOT, "packages/cli/src/main.ts"),
		"--bundle",
		"--platform=node",
		"--format=esm",
		"--target=node24",
		`--outfile=${join(STAGE, "plume.mjs")}`,
		// 都是懒加载：koffi 只在沙箱里用（full 权限不起沙箱），typescript 只给 LSP 用。
		"--external:koffi",
		"--external:typescript",
		// 打进来的 CommonJS 依赖会调 require，ESM 里没有它。
		"--banner:js=import { createRequire as __plumeRequire } from 'node:module'; const require = __plumeRequire(import.meta.url);",
		"--log-level=warning",
	]);
	// `plume://` 文档按 import.meta.url 旁边找，桌面端打包时也是这么带的。
	rmSync(join(STAGE, "plume-docs"), { recursive: true, force: true });
	cpSync(join(ROOT, "packages/core/src/resources/plume-docs"), join(STAGE, "plume-docs"), { recursive: true });
}

/** 和本机同一个版本的 Linux Node，按官方 SHASUMS256 校验。返回可执行文件的路径。 */
function fetchNode(arch: Arch): string {
	const version = `v${process.versions.node}`;
	const dir = join(CACHE, "node", `linux-${arch}`);
	const stamp = join(dir, "VERSION");
	if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) return join(dir, "bin", "node");
	const name = `node-${version}-linux-${arch}.tar.gz`;
	const base = `https://nodejs.org/dist/${version}`;
	const archive = join(CACHE, name);
	console.error(`[eval] ${base}/${name}`);
	// curl 认 https_proxy，Node 的 fetch 不认，理由同 fetch-ripgrep.mjs。
	run("curl", ["-fsSL", "--retry", "3", "-o", archive, `${base}/${name}`]);
	const sums = execFileSync("curl", ["-fsSL", "--retry", "3", `${base}/SHASUMS256.txt`], { encoding: "utf8" });
	const expected = sums.split("\n").find((line) => line.endsWith(`  ${name}`))?.split(" ")[0];
	const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
	if (!expected || expected !== actual) throw new Error(`[eval] ${name} 的 sha256 对不上：期望 ${expected}，实际 ${actual}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	run("tar", ["-xzf", archive, "-C", dir, "--strip-components=1"]);
	rmSync(archive);
	writeFileSync(stamp, `${version}\n`);
	return join(dir, "bin", "node");
}

/**
 * 每个架构一个包：CLI、文档、node、rg，解开就是 plume_agent.py 要的 /opt/plume-eval。
 * 只带 node 可执行文件本身——每道题都要传一次，远端环境走的是本机的上行带宽。
 */
function packBundles(): void {
	mkdirSync(BUNDLE, { recursive: true });
	for (const arch of ARCHES) {
		const dir = join(STAGE, `linux-${arch}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		cpSync(join(STAGE, "plume.mjs"), join(dir, "plume.mjs"));
		cpSync(join(STAGE, "plume-docs"), join(dir, "plume-docs"), { recursive: true });
		cpSync(fetchNode(arch), join(dir, "node"));
		cpSync(fetchRipgrep(`linux-${arch}`), join(dir, "rg"));
		run("tar", ["-czf", join(BUNDLE, `plume-linux-${arch}.tar.gz`), "-C", dir, "."]);
	}
}

/**
 * 对照组的 opencode：npm 上按平台发的预编译二进制，按 registry 给的 sha512 校验。
 * Harbor 自带的安装是在每个容器里 apt → nvm → Node → npm 现装一遍，模拟运行加上本机网络，一道题要装
 * 五六分钟，常常撞上 360 秒的安装上限，被记成未判分。x64 取 baseline：模拟出来的 CPU 没有 AVX2。
 */
function fetchOpencode(): void {
	mkdirSync(BUNDLE, { recursive: true });
	for (const [arch, pkg] of [["x64", "opencode-linux-x64-baseline"], ["arm64", "opencode-linux-arm64"]] as const) {
		const archive = join(BUNDLE, `opencode-linux-${arch}-${OPENCODE_VERSION}.tgz`);
		if (existsSync(archive)) continue;
		const meta = JSON.parse(execFileSync("curl", ["-fsSL", "--retry", "3", `https://registry.npmjs.org/${pkg}/${OPENCODE_VERSION}`], { encoding: "utf8" }));
		console.error(`[eval] ${meta.dist.tarball}`);
		run("curl", ["-fsSL", "--retry", "3", "-o", `${archive}.part`, meta.dist.tarball]);
		const actual = `sha512-${createHash("sha512").update(readFileSync(`${archive}.part`)).digest("base64")}`;
		if (actual !== meta.dist.integrity) throw new Error(`[eval] ${pkg} 的 sha512 对不上：期望 ${meta.dist.integrity}，实际 ${actual}`);
		renameSync(`${archive}.part`, archive);
	}
}

function prepareHarbor(): void {
	if (existsSync(HARBOR)) return;
	run("uv", ["venv", "--python", "3.12", join(CACHE, "venv")]);
	execFileSync("uv", ["pip", "install", `harbor==${HARBOR_VERSION}`], { stdio: "inherit", env: { ...process.env, VIRTUAL_ENV: join(CACHE, "venv") } });
}

function prepareTasks(): void {
	const head = existsSync(TASKS) ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: TASKS, encoding: "utf8" }).trim() : "";
	if (head === TB_COMMIT) return;
	rmSync(TASKS, { recursive: true, force: true });
	run("git", ["init", "-q", TASKS]);
	run("git", ["fetch", "-q", "--depth", "1", TB_REPO, TB_COMMIT], TASKS);
	run("git", ["checkout", "-q", "FETCH_HEAD"], TASKS);
}

/**
 * 结果里的 agent 版本：提交号，下面这几个包有改动时再带上 -dirty 和改动的短哈希。只写 -dirty 的话，同一个提交上
 * 改前改后两次评测的版本一模一样，拿来对照时分不出谁是谁。只算打进 CLI 包的那几个包：桌面端改个
 * 界面不该变成另一个 agent 版本，把同一份代码的补跑拆成两组。
 */
const BUNDLED = ["packages/cli", "packages/core", "packages/registry-shared"];

function plumeVersion(): string {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
	const described = git("describe", "--always").trim();
	const diff = git("diff", "HEAD", "--", ...BUNDLED);
	const untracked = git("ls-files", "--others", "--exclude-standard", "--", ...BUNDLED).split("\n").filter(Boolean);
	if (!diff && !untracked.length) return described;
	const hash = createHash("sha256").update(diff);
	for (const file of untracked) hash.update(file).update(readFileSync(join(ROOT, file)));
	return `${described}-dirty.${hash.digest("hex").slice(0, 8)}`;
}

async function main(): Promise<number> {
	const split = process.argv.indexOf("--");
	const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
	const passthrough = split === -1 ? [] : process.argv.slice(split + 1);
	const option = (name: string) => {
		const at = own.indexOf(name);
		return at === -1 ? undefined : own[at + 1];
	};
	if (own.includes("-h") || own.includes("--help")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const modelId = option("--model");
	if (!modelId) {
		console.error(USAGE);
		return 2;
	}

	// 桌面端的设置（key 从 vault 取回），只摘出这一个模型：容器里不该有别的供应商和别的 key。
	const settings = await loadSettings();
	const provider = settings.providers.find((candidate) => candidate.models.some((model) => model.id === modelId));
	const model = provider?.models.find((candidate) => candidate.id === modelId);
	if (!provider || !model) {
		console.error(`[eval] 设置里没有模型 ${modelId}。可选：\n${settings.providers.flatMap((p) => p.models.map((m) => `  ${m.id}`)).join("\n")}`);
		return 2;
	}
	const thinking = (option("--thinking") ?? settings.thinking) as ThinkingLevel;
	const agent = option("--agent") ?? "plume";
	const vendor = option("--opencode-provider");
	if (agent === "opencode" ? !vendor : agent !== "plume") {
		console.error(USAGE);
		return 2;
	}

	prepareHarbor();
	prepareTasks();
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
	const common = ["run", "--path", join(TASKS, "tasks"), "--jobs-dir", join(CACHE, "jobs"), "--yes"];
	let args: string[];
	let env: Record<string, string>;
	let jobName: string;
	if (agent === "plume") {
		bundleCli();
		packBundles();
		const version = plumeVersion();
		jobName = `plume-${version}-${model.modelId}-${thinking}-${stamp}`;
		args = [
			"--agent", "plume_agent:PlumeAgent",
			"--model", `${provider.name}/${model.modelId}`,
		];
		env = {
			PYTHONPATH: import.meta.dirname,
			// agent 从仓库里导入，不让 Python 往仓库里写 __pycache__。
			PYTHONDONTWRITEBYTECODE: "1",
			PLUME_EVAL_BUNDLE: BUNDLE,
			PLUME_EVAL_SETTINGS: JSON.stringify({
				providers: [{ ...provider, models: [model] }],
				defaultModelId: model.id,
				// 没有人能点批准；full 也就是不起沙箱，和桌面端选「完全访问」时是同一条路径。
				permissionMode: "full",
				thinking,
			}),
			PLUME_EVAL_VERSION: version,
		};
	} else {
		/*
		 * 对照组：Harbor 自带的 opencode agent，同一个模型、同一台机器、同一套题。只有这样两边的数才能
		 * 放在一起比——题目镜像是 amd64，在 Apple Silicon 上模拟跑，超时的比例和 maka 在 x86 上公布的
		 * 不是一回事。opencode 按 models.dev 的供应商名找端点；key 经 opencode_agent.py 交给它。
		 */
		const keyEnv = option("--opencode-key-env") ?? `${vendor?.split("-")[0].toUpperCase()}_API_KEY`;
		fetchOpencode();
		jobName = `opencode-${OPENCODE_VERSION}-${model.modelId}-${thinking}-${stamp}`;
		args = [
			"--agent", "opencode_agent:OpenCodeAgent",
			"--model", `${vendor}/${model.modelId}`,
			"--ak", `variant=${thinking}`,
			"--ak", `version=${OPENCODE_VERSION}`,
		];
		env = {
			PYTHONPATH: import.meta.dirname,
			PYTHONDONTWRITEBYTECODE: "1",
			PLUME_EVAL_BUNDLE: BUNDLE,
			PLUME_BENCH_KEY_ENV: keyEnv,
			[keyEnv]: provider.apiKey,
		};
	}
	jobName = jobName.replace(/[^\w.-]/g, "_");
	console.error(`[eval] ${jobName}`);
	const result = spawnSync(HARBOR, [...common, "--job-name", jobName, ...args, ...passthrough], { stdio: "inherit", env: { ...process.env, ...env } });
	return result.status ?? 1;
}

process.exit(await main());
