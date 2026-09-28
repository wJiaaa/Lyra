/**
 * The two pieces of the Windows backend that are pure string work.
 *
 * They are tested here in full because they are the two places a mistake is both silent and
 * severe, and because they are the parts this machine can actually check — the Win32 calls around
 * them cannot be exercised anywhere but Windows.
 *
 * Quoting is the sharper of the two. A wrong quote does not raise an error: `CreateProcess` hands
 * the program a different set of arguments than the one intended, and a path ending in a backslash
 * is enough to do it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandLine, quoteArg, restrictingSidNames, tempWriteSid, workspaceWriteSid } from "../src/sandbox/windows/identity.ts";

// ---------------------------------------------------------------------------
// Capability SIDs
// ---------------------------------------------------------------------------

test("a workspace SID is well-formed and in the non-unique authority range", () => {
	const sid = workspaceWriteSid("C:\\Users\\me\\project");
	assert.match(sid, /^S-1-4-\d+-\d+$/);
});

test("the same workspace always derives the same SID", () => {
	// This is what lets the directory's ACE be written once rather than once per session.
	assert.equal(workspaceWriteSid("C:\\work\\app"), workspaceWriteSid("C:\\work\\app"));
});

test("different workspaces derive different SIDs", () => {
	assert.notEqual(workspaceWriteSid("C:\\work\\a"), workspaceWriteSid("C:\\work\\b"));
	// Including ones that differ only at the end — a truncating hash would collide here.
	assert.notEqual(workspaceWriteSid("C:\\work\\project1"), workspaceWriteSid("C:\\work\\project2"));
});

test("no subauthority is ever zero", () => {
	// Zero subauthorities are handled inconsistently by Windows tooling, so the derivation offsets
	// away from it rather than relying on the hash never producing one.
	for (const path of ["C:\\a", "C:\\b", "D:\\very\\deep\\path\\here", "\\\\server\\share"]) {
		for (const part of workspaceWriteSid(path).split("-").slice(3)) {
			assert.ok(Number(part) > 0, `${path} → ${part}`);
		}
	}
});

test("subauthorities stay inside 30 bits", () => {
	for (const path of ["C:\\x", "C:\\y", "C:\\z", "C:\\long\\path\\with\\many\\segments"]) {
		for (const part of workspaceWriteSid(path).split("-").slice(3)) {
			assert.ok(Number(part) < 2 ** 30, `${path} → ${part}`);
		}
	}
});

test("a temp SID can never be mistaken for a workspace SID", () => {
	// Sharing an identity would let every session write every other session's temp tree.
	const temp = tempWriteSid("C:\\Temp\\plume-abc123");
	assert.match(temp, /^S-1-4-\d+-\d+-1$/);
	assert.notEqual(temp, workspaceWriteSid("C:\\Temp\\plume-abc123"));
});

test("the temp derivation is domain-separated, not just suffixed", () => {
	// Same input, different derivation: the first two subauthorities must differ too, or the
	// separator would be doing no work.
	const path = "C:\\Temp\\same";
	const workspaceParts = workspaceWriteSid(path).split("-").slice(3, 5);
	const tempParts = tempWriteSid(path).split("-").slice(3, 5);
	assert.notDeepEqual(workspaceParts, tempParts);
});

// ---------------------------------------------------------------------------
// Command-line quoting
// ---------------------------------------------------------------------------

test("an argument with nothing special is left bare", () => {
	assert.equal(quoteArg("hello"), "hello");
	assert.equal(quoteArg("C:\\dir\\file.txt"), "C:\\dir\\file.txt");
});

test("an empty argument still has to be an argument", () => {
	// Bare, it would vanish and shift every following argument by one.
	assert.equal(quoteArg(""), '""');
});

test("spaces get quotes", () => {
	assert.equal(quoteArg("hello world"), '"hello world"');
	assert.equal(quoteArg("C:\\Program Files\\app.exe"), '"C:\\Program Files\\app.exe"');
});

test("a trailing backslash before a closing quote is doubled", () => {
	// This is the one that bites: `"C:\dir\"` escapes its own closing quote and swallows the rest
	// of the command line into the argument.
	assert.equal(quoteArg("C:\\my dir\\"), '"C:\\my dir\\\\"');
	assert.equal(quoteArg("a b\\\\"), '"a b\\\\\\\\"');
});

test("a backslash run before a literal quote is doubled plus one", () => {
	assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
	assert.equal(quoteArg('a\\"b c'), '"a\\\\\\"b c"');
});

test("backslashes not before a quote are left alone", () => {
	// `C:\a\b` inside quotes is literal; doubling it would change the path.
	assert.equal(quoteArg("C:\\a\\b c"), '"C:\\a\\b c"');
});

test("quoting round-trips through the CRT's own splitting rules", () => {
	// The real test of a quoter is the parser. This is the documented algorithm a program uses to
	// split the command line back up; anything that survives it will reach the program intact.
	const split = (line: string): string[] => {
		const out: string[] = [];
		let current = "";
		let inQuotes = false;
		let started = false;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === "\\") {
				let slashes = 0;
				while (i < line.length && line[i] === "\\") {
					slashes++;
					i++;
				}
				if (i < line.length && line[i] === '"') {
					current += "\\".repeat(Math.floor(slashes / 2));
					if (slashes % 2 === 1) {
						current += '"';
						started = true;
					} else {
						inQuotes = !inQuotes;
						started = true;
					}
				} else {
					current += "\\".repeat(slashes);
					if (slashes > 0) started = true;
					i--;
				}
				continue;
			}
			if (char === '"') {
				inQuotes = !inQuotes;
				started = true;
				continue;
			}
			if (!inQuotes && /\s/.test(char)) {
				if (started) out.push(current);
				current = "";
				started = false;
				continue;
			}
			current += char;
			started = true;
		}
		if (started) out.push(current);
		return out;
	};

	const cases = [
		["simple"],
		["with space", "another"],
		["C:\\Program Files\\node.exe", "-e", 'console.log("hi")'],
		["trailing\\", "next"],
		["", "after empty"],
		['quote"inside', "a\\\\b"],
		["C:\\dir\\", "-flag", "value with spaces"],
	];
	for (const argv of cases) {
		assert.deepEqual(split(buildCommandLine(argv[0], argv.slice(1))), argv, JSON.stringify(argv));
	}
});

// ---------------------------------------------------------------------------
// The restricting list — the sandbox itself
// ---------------------------------------------------------------------------

test("read-only carries no write capability at all", () => {
	const list = restrictingSidNames("read-only", ["S-1-4-1-2"]);
	assert.deepEqual(list.write, [], "a leftover ACE from an earlier session stays inert this way");
});

test("workspace-write carries the write capabilities it was given", () => {
	const list = restrictingSidNames("workspace-write", ["S-1-4-1-2", "S-1-4-3-4-1"]);
	assert.deepEqual(list.write, ["S-1-4-1-2", "S-1-4-3-4-1"]);
});

test("duplicate capabilities collapse", () => {
	assert.deepEqual(restrictingSidNames("workspace-write", ["S-1-4-1-2", "S-1-4-1-2"]).write, ["S-1-4-1-2"]);
});

test("workspace-write with no capability is refused rather than silently read-only", () => {
	// A token restricted to nothing writable would fail every write, and the failure would look
	// like a sandbox bug rather than a construction mistake.
	assert.throws(() => restrictingSidNames("workspace-write", []), /至少需要一个/);
});

test("the two keep-alive identities are always present", () => {
	// Without them the process dies during loader init, before any of our code runs — which is
	// also why enforcement here is reported as partial rather than full.
	for (const mode of ["read-only", "workspace-write"] as const) {
		const list = restrictingSidNames(mode, ["S-1-4-9-9"]);
		assert.equal(list.logon, true);
		assert.equal(list.world, true);
	}
});
