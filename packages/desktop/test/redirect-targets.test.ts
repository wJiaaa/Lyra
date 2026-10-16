/**
 * Where a background job's output went when its log is empty. The case behind this: `go test … >
 * run.log 2>&1` failed with exit code 1, and the task panel showed an empty box under it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redirectTargets } from "../src/lib/redirect-targets.ts";

describe("redirectTargets", () => {
	it("names the file both streams were sent into", () => {
		assert.deepEqual(redirectTargets("cd /repo && go test ./... > /tmp/run.log 2>&1"), ["/tmp/run.log"]);
	});

	it("reads targets stuck to the operator, appends, fds and &>", () => {
		assert.deepEqual(redirectTargets("make >out.log 2>err.log"), ["out.log", "err.log"]);
		assert.deepEqual(redirectTargets("cmd >> a.log"), ["a.log"]);
		assert.deepEqual(redirectTargets("cmd >| a.log"), ["a.log"]);
		assert.deepEqual(redirectTargets('npm run x &> "my log.txt"'), ["my log.txt"]);
		assert.deepEqual(redirectTargets("npm run x &>>all.log"), ["all.log"]);
	});

	it("follows every command in a chain or pipeline, once per file", () => {
		assert.deepEqual(redirectTargets("echo hi | tee x > y; cmd >> y"), ["y"]);
	});

	it("does not count moving one stream onto another, or throwing it away", () => {
		assert.deepEqual(redirectTargets("cmd 2>&1 | tail"), []);
		assert.deepEqual(redirectTargets("cmd >&2"), []);
		assert.deepEqual(redirectTargets("cmd > /dev/null 2>&1"), []);
	});

	it("is empty for a plain command", () => {
		assert.deepEqual(redirectTargets("pnpm dev"), []);
	});
});
