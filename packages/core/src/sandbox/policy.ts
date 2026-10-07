/**
 * What a confined command may touch, expressed once and translated per platform.
 *
 * Everything here is pure: a mode plus a workspace root in, an allow-list or a profile string out.
 * That is deliberate — the part of a sandbox you can get wrong silently is the part that decides
 * which paths are writable, and a pure function is the part you can actually test. The impure half
 * (probing a runner, wrapping an argv) lives in `local.ts`.
 *
 * The mode governs file effects only. Commands may reach the network in every mode.
 * Process visibility is still not in the vocabulary.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * How much of the filesystem a command may change.
 *
 * `read-only` permits no writes at all beyond the sinks a shell cannot run without; the pipeline
 * a shell builds needs `/dev/null`, and denying it turns "no writes" into "no commands".
 * `workspace-write` adds the project and the temp areas. `danger-full-access` is not confined at
 * all — it is the absence of a sandbox, named so the absence has to be chosen.
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** 文件写入受到约束的模式。 */
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">;

/**
 * How completely the host can keep the promise, reported rather than assumed.
 *
 * `partial` means the backend governs some of the mode's promise and not all of it. A caller that
 * needs the absolute boundary has to treat it as a different answer from `full` — which is the
 * whole reason it is a value and not a boolean.
 */
export type SandboxEnforcement = "full" | "partial";

export interface SandboxPolicy {
	mode: SandboxMode;
	/** Absolute path `workspace-write` may write under. Canonicalised here, not by the caller. */
	workspaceRoot: string;
}

/**
 * The path the enforcement layer will actually compare against.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, and a Seatbelt filter matches the resolved path.
 * Granting the spelling the caller used would grant a path no process ever reports being in — the
 * grant would be there in the profile and mean nothing at runtime.
 *
 * `realpathSync.native` rather than the JavaScript one: the JS implementation collapses `..`
 * lexically before resolving a symlink in front of it, so `link/..` can resolve somewhere the
 * kernel would never go. The native one walks it component by component, the way `chdir` and
 * `spawn` do.
 *
 * A path that cannot be resolved is returned as spelled. It names nothing yet, so it grants
 * nothing yet — the conservative outcome. Inventing a fallback would grant a path nobody asked for.
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * The roots a confined command may write under, canonical and deduplicated.
 *
 * `/tmp` and `os.tmpdir()` are both here and are usually the same directory after canonicalisation
 * — but only usually. `TMPDIR` moves the second one per user on macOS, and a `mkstemp`-family tool
 * writes there rather than to `/tmp`. Granting one and not the other denies what the mode promises,
 * in a way that only shows up in whichever tool happens to use the other.
 *
 * A root contained by another is dropped. Two overlapping grants are not wrong, but they make the
 * generated profile say the same thing twice, and a profile that repeats itself is one nobody
 * reads carefully.
 */
export function writableRoots(policy: SandboxPolicy): string[] {
	if (policy.mode !== "workspace-write") return [];
	const canonical = [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
	return canonical.filter((root) => !canonical.some((other) => other !== root && contains(other, root)));
}

/** Whether `parent` contains `child`, comparing whole path segments so `/a/bc` is not under `/a/b`. */
function contains(parent: string, child: string): boolean {
	if (parent === child) return false;
	const base = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(base);
}

/**
 * One path as an SBPL string literal.
 *
 * The escaping is the security boundary, not a formatting detail. A profile is a string the kernel
 * parses, so a directory named `foo"` would end the literal early and the rest of the path would
 * be read as more profile — which is a grant nobody wrote. Backslash first, or escaping the quote
 * would then have its own backslash escaped.
 */
function sbplString(path: string): string {
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The macOS Seatbelt profile for a policy, as arguments to `sandbox-exec`.
 *
 * `(allow default)` and then one denial, rather than denying everything and allowing back what is
 * needed. A default-deny profile has to enumerate every syscall family a shell touches — dyld,
 * mach ports, the terminal — and each one it misses is a command that mysteriously fails. The
 * promise of this vocabulary is file *effects*; denying `file-write*` is that promise, exactly.
 *
 * `/dev/null` is granted under every mode because a shell redirects to it constantly and a
 * `read-only` sandbox that cannot run `command 2>/dev/null` is not read-only, it is broken.
 */
export function seatbeltArgs(policy: SandboxPolicy): string[] {
	const forms = ["(version 1)", "(allow default)"];
	if (policy.mode !== "danger-full-access") {
		forms.push("(deny file-write*)", `(allow file-write* (literal ${sbplString("/dev/null")}))`);
		const roots = writableRoots(policy);
		if (roots.length > 0) {
			forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
		}
	}
	return ["-p", forms.join(" ")];
}

/**
 * The Linux `bwrap` arguments for a policy.
 *
 * The whole filesystem is bound read-only and the writable roots are bound back over it, which is
 * the mount-namespace way of saying the same thing the Seatbelt profile says. `--die-with-parent`
 * so a killed turn does not leave the wrapped command running, and `--dev`/`--proc` because a
 * namespace without them is missing the two things almost every program expects to exist.
 */
export function bwrapArgs(policy: SandboxPolicy): string[] {
	const args = [policy.mode === "danger-full-access" ? "--bind" : "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
	for (const root of writableRoots(policy)) args.push("--bind", root, root);
	return args;
}
