import assert from "node:assert/strict";
import { test } from "node:test";
import { assessNetwork } from "../src/tools/risk-network.ts";

const decide = (url: string, method?: string) => assessNetwork({ url, method }).decision;

test("读取网页不区分公网、内网和本机地址", () => {
	for (const url of [
		"https://example.com/docs",
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://192.168.1.1/",
		"http://169.254.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.64.0.1/",
		"http://0.0.0.0/",
		"http://[fc00::1]/",
		"http://[fe80::1]/",
		"http://[::ffff:192.168.1.1]/",
		"http://3232235777/",
		"http://0300.0250.1.1/",
		"http://localhost:3000/",
		"http://127.0.0.1:5173/",
		"http://[::1]:8080/",
		"http://intranet.local/",
	]) {
		for (const method of [undefined, "GET", "HEAD", "OPTIONS"]) {
			assert.equal(decide(url, method), "allow", `${method ?? "GET"} ${url}`);
		}
	}
});

test("写请求仍需审批，内网和本机与公网使用同一规则", () => {
	for (const url of ["https://example.com/x", "http://192.168.1.1/x", "http://localhost:3000/x"]) {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const verdict = assessNetwork({ url, method: method.toLowerCase() });
			assert.equal(verdict.decision, "ask", `${method} ${url}`);
			if (verdict.decision === "ask") {
				assert.equal(verdict.code, "method-writes");
				assert.deepEqual(verdict.params, { method });
			}
		}
	}
});

test("only http and https", () => {
	for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
		assert.equal(decide(url), "refuse", url);
	}
});

test("credentials in the URL are refused", () => {
	assert.equal(decide("https://user:pass@example.com/"), "refuse");
	assert.equal(decide("http://user:pass@192.168.1.1/"), "refuse");
	assert.equal(decide("https://user@example.com/"), "refuse");
});

test("an unparseable address is refused rather than guessed at", () => {
	assert.equal(decide("not a url"), "refuse");
	assert.equal(decide(""), "refuse");
});
