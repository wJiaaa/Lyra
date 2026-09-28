/**
 * Packaging, and the one decision it has to make: what to sign with.
 *
 * `electron-builder.yml` pins `mac.identity: "-"` so that no path ever leaves a bundle unsigned.
 * This overrides that pin — and only that pin — when a real signing identity is available.
 *
 * Why it matters is in `electron-builder.yml` and `make-signing-cert.sh`: ad-hoc signing ties the
 * app's identity to a hash of its own executable, so every update is a different application to
 * macOS and every permission granted to the previous one is revoked. Signing with a certificate —
 * any certificate, including a self-signed one — ties it to the certificate instead.
 *
 * **Why the identity is looked up rather than handed over.** electron-builder can import a `.p12`
 * itself from `CSC_LINK`, and that path is broken in 26.15.3: it creates the temporary keychain
 * with a random password
 *
 *     const keychainPassword = randomBytes(32).toString("base64")
 *
 * and then unlocks it with the *certificate's* password
 *
 *     ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]
 *
 * which fails with "The user name or passphrase you entered is not correct" — about a password
 * that is correct. So the keychain is prepared by whoever is calling (see `release.yml`), and all
 * that is needed here is the name to sign under.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The name in the certificate `make-signing-cert.sh` generates. */
const DEFAULT_IDENTITY = "Plume Code Signing";

const mac = process.platform === "darwin";
const identity = process.env.MAC_SIGNING_IDENTITY?.trim() || DEFAULT_IDENTITY;

/**
 * Whether that identity is actually usable for signing right now.
 *
 * Asked of the system rather than inferred from an environment variable, because the thing that
 * can go wrong is precisely that a variable was set and the keychain was not prepared — and the
 * result of guessing wrong is a build that silently signs ad-hoc and ships with permissions that
 * reset. `-v` restricts the answer to valid identities: an untrusted certificate is listed by
 * `find-identity` but refused by `codesign`, and this must agree with `codesign`.
 */
function identityAvailable() {
	const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
	return found.status === 0 && found.stdout.includes(identity);
}

const args = process.argv.slice(2);
if (mac && identityAvailable()) {
	args.push(`-c.mac.identity=${identity}`);
	console.log(`[package] signing as "${identity}" — updates will keep their permissions`);
} else if (mac) {
	console.log(`[package] no "${identity}" in the keychain: signing ad-hoc`);
	console.log("[package] macOS will treat this build as a new app and reset its permissions");
	console.log("[package] see packages/desktop/scripts/make-signing-cert.sh");
}

const result = spawnSync("electron-builder", args, { stdio: "inherit", shell: process.platform === "win32" });

/*
 * Put `node_modules` back the way this machine needs it.
 *
 * electron-builder rebuilds native modules for whatever architecture it is packaging, in the
 * project's own `node_modules` — not in a copy. Building a universal or multi-arch release
 * therefore ends with `node-pty` compiled for whichever architecture went last, and on an Apple
 * Silicon machine that is x86_64. Nothing says so at the time; the next `npm run dev`, e2e probe or
 * packaged-app-from-source run dies on launch with
 *
 *     dlopen(.../pty.node): incompatible architecture (have 'x86_64', need 'arm64')
 *
 * in a main-process crash dialog, which reads as the app being broken rather than as the last
 * build having left the tree pointed elsewhere. `rebuild:pty` builds for the local Electron, so
 * this simply undoes it.
 *
 * After the build, and regardless of whether it succeeded: a failed package run leaves the modules
 * just as rebuilt as a successful one.
 */
const restore = spawnSync(process.execPath, [fileURLToPath(new URL("rebuild-pty.mjs", import.meta.url))], {
	stdio: "inherit",
});
if (restore.status !== 0) {
	console.warn("[package] 原生模块没能恢复成本机架构，开发运行前请手动执行 npm run rebuild:pty");
}

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

/*
 * Whether what was just built carries native binaries for the architecture it claims to be.
 *
 * Packaging cannot tell on its own. Prebuilt per-platform modules are copied in as found, so a
 * build takes whatever the *build machine* happened to need — which is how 0.8.35's arm64 Windows
 * installer came to hold an x64 `koffi.node`. Nothing failed: it packaged, it installed, it
 * launched, and the mismatch waited for a user on that architecture to reach the one code path that
 * loads it. `pnpm-workspace.yaml` now installs every platform's copy, and this is what confirms the
 * right one arrived — the fix and its check, rather than the fix alone.
 *
 * Only after a successful package: there is nothing to inspect otherwise, and a second failure
 * stacked on the first only buries it.
 *
 * `fileURLToPath`, not `.pathname` as above: on Windows the latter yields `/C:/…`, and this one
 * decides an exit code — a path that fails to resolve would block a release over nothing.
 */
const arch = spawnSync(process.execPath, [fileURLToPath(new URL("check-native-arch.mjs", import.meta.url))], {
	stdio: "inherit",
});
process.exit(arch.status ?? 1);
