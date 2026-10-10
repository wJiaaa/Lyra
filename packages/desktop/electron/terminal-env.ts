/**
 * The environment a new terminal's shell starts with.
 *
 * Two corrections to what this process inherited. Both are about where the app was launched from,
 * which the user never thinks about — they expect the terminal they would get from the Dock or the
 * Start menu, not one that remembers how Plume itself was started.
 *
 * No Electron values here, so both are driven straight from a test.
 */

import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { envValue } from "./find-executable.ts";

/**
 * The inherited environment, plus what describes this emulator.
 *
 * TERM is what makes a shell emit colour and use cursor addressing at all. COLORTERM says xterm.js
 * takes 24-bit colour; without it starship, bat and delta fall back to 256. Both describe this
 * emulator, so whatever the launching terminal set is overwritten.
 *
 * On macOS a Dock launch has no locale at all, and a shell in the C locale shows a Chinese file name
 * as `\M-d\M-8...`. A zsh login shell repairs it through `/etc/zprofile` on current macOS, but not
 * bash, and not older releases. Only `LC_CTYPE` is set, and only when all three are empty: it is
 * the variable that decides how bytes become characters, and leaving `LANG` alone keeps sorting
 * and number formatting where the user's own files put them — t3code settled on the same rule.
 */
export function shellEnv(platform: string, base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	if (platform === "darwin" && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LC_CTYPE = "en_US.UTF-8";
	return env;
}

/**
 * The Windows environment as the registry has it now, over the one this process started with.
 *
 * A process's environment is a copy taken when it starts. Install Node while Plume is open and every
 * new tab still lacked `node`, until Plume itself was restarted — a terminal that cannot see what
 * was just installed, while the one in the Start menu can. Windows Terminal and VS Code both
 * re-read the registry for each new shell for this reason.
 *
 * User values win over machine values, which is how Windows builds a login environment. `PATH` is
 * the exception both ways: machine then user, and anything the inherited one had beyond those is
 * kept at the end, so a directory added by whatever launched Plume is not lost. `USERNAME` is skipped
 * because the machine key holds `SYSTEM` there.
 */
export function withRegistryEnv(
	inherited: NodeJS.ProcessEnv,
	machine: Record<string, string>,
	user: Record<string, string>,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...inherited };
	const keyOf = (name: string) => Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
	// Under the spelling already there: a second key differing only in case would leave the child
	// with both, and which one wins is not ours to predict.
	const assign = (name: string, value: string) => {
		env[keyOf(name) ?? name] = value;
	};
	for (const source of [machine, user]) {
		for (const [name, value] of Object.entries(source)) {
			if (/^(path|username)$/i.test(name) || typeof value !== "string") continue;
			assign(name, value);
		}
	}
	const pathOf = (source: NodeJS.ProcessEnv | Record<string, string>) => envValue(source, "Path", "win32") ?? "";
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const dir of [pathOf(machine), pathOf(user), envValue(inherited, "Path", "win32") ?? ""].join(";").split(";")) {
		const key = dir.trim().replace(/[\\/]+$/, "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		dirs.push(dir.trim());
	}
	if (dirs.length > 0) assign("Path", dirs.join(";"));
	return env;
}

/** What the registry holds, already expanded; `null` when it could not be read. */
export type RegistryReader = () => Promise<{ machine: Record<string, string>; user: Record<string, string> } | null>;

/**
 * PowerShell rather than `reg query`: `reg` prints in the console code page, which on a Chinese
 * Windows is GBK, and a user directory with a Chinese name came back as mojibake. This prints JSON
 * in UTF-8, and `GetEnvironmentVariables` expands `%USERPROFILE%`-style values on the way.
 */
const READ_SCRIPT =
	"[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
	"@{machine=[Environment]::GetEnvironmentVariables('Machine');user=[Environment]::GetEnvironmentVariables('User')}|ConvertTo-Json -Compress -Depth 3";

export function readRegistryEnv(env: NodeJS.ProcessEnv = process.env): ReturnType<RegistryReader> {
	const root = envValue(env, "SystemRoot", "win32");
	const powershell = root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
	return new Promise((resolve) => {
		execFile(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
			{ encoding: "utf8", timeout: 5_000, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve(null);
				try {
					const parsed = JSON.parse(stdout) as { machine?: Record<string, string>; user?: Record<string, string> };
					resolve({ machine: parsed.machine ?? {}, user: parsed.user ?? {} });
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/**
 * The registry's environment, kept fresh without a new tab ever paying for PowerShell's start.
 *
 * Reading it takes a few hundred milliseconds, too long to do on the main process for every tab.
 * So it is read ahead: at launch, and whenever a Plume window takes focus — coming back from an
 * installer is exactly that. A tab opened while a read is still running waits for it, briefly; a
 * read that fails or is slow leaves the last good answer, or the inherited environment, in place.
 */
export function createRegistryEnv(read: RegistryReader, wait = 1_500, every = 10_000) {
	let latest: { machine: Record<string, string>; user: Record<string, string> } | null = null;
	let inFlight: Promise<void> | null = null;
	let last = Number.NEGATIVE_INFINITY;

	// Not on every focus: alt-tabbing would start a PowerShell each time. Coming back from an
	// installer is minutes after the last read, never seconds.
	const refresh = (): void => {
		if (inFlight || Date.now() - last < every) return;
		last = Date.now();
		inFlight = read()
			.then((answer) => {
				if (answer) latest = answer;
			})
			.finally(() => {
				inFlight = null;
			});
	};

	/** Resolves once a running read has finished, or after `wait`, whichever is first. */
	const settled = async (): Promise<void> => {
		if (!inFlight) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([inFlight, new Promise<void>((done) => (timer = setTimeout(done, wait)))]);
		clearTimeout(timer);
	};

	const current = (inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
		latest ? withRegistryEnv(inherited, latest.machine, latest.user) : inherited;

	return { refresh, settled, current };
}
