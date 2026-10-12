/**
 * 起一台 stdio MCP 服务器：环境变量怎么给、怎么关掉整棵进程树、它在 stderr 上说了什么。
 *
 * 从 `client.ts` 拆出来：那边管连接的生死，这边管一个进程。
 */

import { execFile } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commandEnv } from "../sandbox/login-path.ts";
import { looksSecret } from "./placeholders.ts";
import type { McpStdioServer } from "./types.ts";

/**
 * 留多少 stderr：最后 20 行，每行最多 500 字符，合计不超过 4000 字符。
 *
 * 一台起不来的服务器，原因几乎总在 stderr 的最后几行——找不到模块、缺环境变量、端口被占。以前
 * stderr 直接接到宿主进程上（SDK 的默认 `inherit`），桌面端里那是一个没人看的控制台，设置页上只剩
 * SDK 的一句「Connection closed」。行数和字符数都要限：有的服务器把整个依赖树的警告打出来，也有
 * 的一行就是一整段压缩过的 JSON。
 */
const STDERR_LINES = 20;
const STDERR_LINE_CHARS = 500;
const STDERR_CHARS = 4000;

/**
 * The SDK's stdio transport, with a close that reaches the server on Windows, and with the server's
 * stderr kept instead of sent to a console nobody reads.
 *
 * On Windows the SDK starts anything that is not an `.exe` — `npx`, a `.cmd` shim — through `cmd.exe
 * /d /s /c` (cross-spawn), and its close ends stdin, waits, then `kill()`s: which terminates `cmd.exe`
 * and nothing under it. The real server was orphaned, ran for the rest of the session and kept its
 * files open, so updating or uninstalling the bundle it came from failed halfway with EPERM.
 *
 * The tree has to be taken while `cmd.exe` is still there to name it — once it is gone `/T` has no
 * root to walk from — so this runs before the SDK's close rather than after. That skips the SDK's
 * grace period on Windows: a server stopped this way does not see stdin close first. An orphan
 * holding the plugin's files open is the worse of the two.
 */
export class TreeKillingStdioTransport extends StdioClientTransport {
	private readonly lines: string[] = [];
	private partial = "";
	private readonly secrets: string[];

	constructor(server: McpStdioServer) {
		super({ command: server.command, args: server.args ?? [], env: stdioEnv(server.env), stderr: "pipe" });
		// 服务器把自己的配置连同密钥一起打到 stderr 上并不少见；这段文字要进设置页和模型的上下文。
		this.secrets = Object.entries(server.env ?? {})
			.filter(([name, value]) => looksSecret(name) && value.length >= 6)
			.map(([, value]) => value);
		this.stderr?.on("data", (chunk: Buffer | string) => this.keep(String(chunk)));
	}

	/** stderr 的最后几行，已经去掉了这台服务器自己的密钥。没有输出时是空字符串。 */
	stderrTail(): string {
		const lines = this.partial ? [...this.lines, this.partial] : this.lines;
		let text = lines.slice(-STDERR_LINES).join("\n");
		if (text.length > STDERR_CHARS) text = text.slice(-STDERR_CHARS);
		for (const secret of this.secrets) text = text.split(secret).join("[secret]");
		return text.trim();
	}

	private keep(chunk: string): void {
		const parts = (this.partial + chunk).split(/\r?\n/);
		this.partial = (parts.pop() ?? "").slice(0, STDERR_LINE_CHARS);
		for (const line of parts) if (line.trim()) this.lines.push(line.slice(0, STDERR_LINE_CHARS));
		if (this.lines.length > STDERR_LINES) this.lines.splice(0, this.lines.length - STDERR_LINES);
	}

	override async close(): Promise<void> {
		const pid = this.pid;
		// `pid` is null once the process has exited, so a PID the OS has since reused is never named.
		if (process.platform === "win32" && pid !== null) await killTree(pid);
		await super.close();
	}
}

function killTree(pid: number): Promise<void> {
	return new Promise((resolve) => {
		// The Electron main process has no console; without `windowsHide` every stop flashes one.
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
	});
}

/**
 * The environment a stdio server is started with: the one the agent's own commands get, then the
 * server's configured `env` on top.
 *
 * It was `process.env`. From an icon that is launchd's four system directories and nothing else,
 * and most servers are configured as `npx -y @scope/server` — so `npx` was not found wherever nvm,
 * fnm or volta put it, or it was found and the download timed out without the `https_proxy` the
 * user's shell exports. `commandEnv` is what repairs both for `bash` and hooks; see `login-path.ts`.
 *
 * On Windows the SDK lays its own copy of a few variables underneath ours, spelled in capitals
 * (`DEFAULT_INHERITED_ENV_VARS`), while `{ ...process.env }` keeps the system's spelling — `Path`,
 * `SystemRoot`. Left alone, the child gets both `PATH` and `Path`, and which one it reads is decided
 * by Node sorting the keys, not by us: a `Path` the user set in the server's `env` loses to the
 * SDK's inherited `PATH`. So names are folded case-insensitively, the later write wins, and those
 * few are written in the SDK's spelling so they replace its copy instead of sitting beside it.
 */
function stdioEnv(overrides: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	const windows = process.platform === "win32";
	const spelled = new Map<string, string>();
	const put = (key: string, value: string | undefined) => {
		if (value === undefined) return;
		if (!windows) {
			env[key] = value;
			return;
		}
		const folded = key.toUpperCase();
		const previous = spelled.get(folded);
		if (previous !== undefined) delete env[previous];
		const name = DEFAULT_INHERITED_ENV_VARS.includes(folded) ? folded : key;
		spelled.set(folded, name);
		env[name] = value;
	};
	for (const [key, value] of Object.entries(commandEnv(process.env))) put(key, value);
	for (const [key, value] of Object.entries(overrides ?? {})) put(key, value);
	return env;
}
