/**
 * The address space: parsing, routing, the four shipped schemes, and the two boundaries.
 *
 * The boundaries are the reason most of this file exists. One is that a path cannot climb out of
 * the namespace it names — including through a symlink, where the textual path never leaves and
 * the read does. The other is that almost nothing is writable, so a model cannot edit the
 * instructions that constrain it by addressing them.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_RESOURCES } from "../src/resources/handlers.ts";
import { parseResourceUrl, ResourceRouter, resolveInside } from "../src/resources/router.ts";
import type { ResourceContext } from "../src/resources/types.ts";
import { editTool } from "../src/tools/edit.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readLocalPageFor } from "../src/tools/preview.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolContext } from "../src/types.ts";

let root: string;
let skillDir: string;
let scratchDir: string;
let outside: string;

function router(): ResourceRouter {
	const r = new ResourceRouter();
	for (const handler of BUILTIN_RESOURCES) r.register(handler);
	return r;
}

function state(): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			"skills",
			[
				{
					name: "pdf",
					description: "读 PDF",
					content: "# PDF 技能\n\n第一步。\n第二步。\n第三步。",
					path: join(skillDir, "SKILL.md"),
					dir: skillDir,
					source: "workspace",
					disableModelInvocation: false,
				},
			],
		],
	]);
}

function ctx(): ResourceContext {
	return { cwd: root, sessionId: "s1", scratchDir, state: state() };
}

function toolCtx(): ToolContext {
	return { cwd: root, sessionId: "s1", state: state(), resources: router(), scratchDir } as unknown as ToolContext;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-res-"));
	skillDir = join(root, "skills", "pdf");
	scratchDir = join(root, "scratch");
	outside = join(root, "secret.txt");
	await mkdir(skillDir, { recursive: true });
	await mkdir(scratchDir, { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), "# PDF 技能\n");
	await writeFile(join(skillDir, "template.txt"), "模板内容\n");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await writeFile(join(skillDir, "references", "03-guide.md"), "# 指南\n");
	await writeFile(outside, "不该被读到\n");
	await symlink(outside, join(skillDir, "escape.txt")).catch(() => {});
});

after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("an address needs a scheme and `://`", () => {
	assert.equal(parseResourceUrl("skill://pdf")?.scheme, "skill");
	assert.equal(parseResourceUrl("src/app.ts"), null);
	assert.equal(parseResourceUrl("note:todo"), null, "a bare colon is not an address");
});

test("a Windows drive letter is not a scheme", () => {
	/*
	 * The `://` is required for this. A looser pattern captures `C:\Users\me\file.ts`, and the
	 * failure is a path that silently stops resolving on one platform only.
	 */
	assert.equal(parseResourceUrl("C:\\Users\\me\\file.ts"), null);
	assert.equal(parseResourceUrl("C:/Users/me/file.ts"), null);
});

test("a trailing line range is parsed off the path", () => {
	const parsed = parseResourceUrl("skill://pdf:10-40");
	assert.equal(parsed?.path, "pdf");
	assert.deepEqual(parsed?.range, { from: 10, to: 40 });

	const single = parseResourceUrl("skill://pdf:7");
	assert.deepEqual(single?.range, { from: 7, to: undefined });
});

test("segments drop empty parts, so a trailing slash is not a segment", () => {
	assert.deepEqual(parseResourceUrl("skill://pdf/docs/a.md")?.segments, ["pdf", "docs", "a.md"]);
	assert.deepEqual(parseResourceUrl("skill://")?.segments, []);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("an unknown scheme is not claimed, so it can fall through to the filesystem", () => {
	const r = router();
	assert.equal(r.canResolve("skill://pdf"), true);
	assert.equal(r.canResolve("acme://thing"), false);
	assert.equal(r.looksLikeUrl("acme://thing"), true, "it is still recognisably an address");
});

test("registering a scheme twice is refused", () => {
	const r = router();
	assert.throws(() => r.register(BUILTIN_RESOURCES[0]), /already registered/);
});

test("a bare scheme lists what is in it", async () => {
	const listed = await router().resolve("skill://", ctx());
	assert.match(listed.content, /skill:\/\/pdf/);
});

// ---------------------------------------------------------------------------
// skill://
// ---------------------------------------------------------------------------

test("skill:// returns the body, and a range slices it", async () => {
	const whole = await router().resolve("skill://pdf", ctx());
	assert.match(whole.content, /第一步/);

	const sliced = await router().resolve("skill://pdf:3-3", ctx());
	assert.equal(sliced.content, "第一步。");
});

test("skill://<name>/<path> reads a file from the skill directory", async () => {
	const file = await router().resolve("skill://pdf/template.txt", ctx());
	assert.match(file.content, /模板内容/);
});

test("a path that climbs out of the skill directory is refused", async () => {
	await assert.rejects(() => router().resolve("skill://pdf/../../../etc/passwd", ctx()), /技能目录外面/);
});

test("a symlink out of the skill directory is refused", async () => {
	/*
	 * The textual path never leaves — `escape.txt` is right there in the directory — so the string
	 * check passes and the read would succeed. Only resolving the link catches it.
	 */
	await assert.rejects(() => router().resolve("skill://pdf/escape.txt", ctx()), /软链/);
});

test("an unknown skill names the ones that exist", async () => {
	await assert.rejects(() => router().resolve("skill://nope", ctx()), /现有的是：pdf/);
});

test("a trailing slash lists a skill directory at any depth, not only the top", async () => {
	const top = await router().resolve("skill://pdf/", ctx());
	assert.match(top.content, /^- skill:\/\/pdf\/references\/$/m, "a subdirectory is marked so it can be listed next");

	// 只有顶层会列时，这里落到 readFile 上，回答的是“没有 references/”。
	const sub = await router().resolve("skill://pdf/references/", ctx());
	assert.equal(sub.content, "- skill://pdf/references/03-guide.md");

	await assert.rejects(() => router().resolve("skill://pdf/nope/", ctx()), /没有 nope\/ 这个目录/);
	await assert.rejects(() => router().resolve("skill://pdf/../../", ctx()), /技能目录外面/);
});

// ---------------------------------------------------------------------------
// scratch://
// ---------------------------------------------------------------------------

test("scratch:// round-trips", async () => {
	const r = router();
	await r.write("scratch://notes/a.md", "写下来的内容", ctx());
	const back = await r.resolve("scratch://notes/a.md", ctx());
	assert.equal(back.content, "写下来的内容");
});

test("a scratch path cannot climb out", async () => {
	await assert.rejects(() => router().write("scratch://../escaped.md", "x", ctx()), /临时目录外面/);
});

test("the first write into a scratch directory that does not exist yet, under a symlinked tmpdir, is allowed", async () => {
	const fresh = join(await mkdtemp(join(tmpdir(), "ly-scratch-fresh-")), "not-yet");
	await router().write("scratch://a/b.md", "ok", { ...ctx(), scratchDir: fresh });
	assert.equal((await router().resolve("scratch://a/b.md", { ...ctx(), scratchDir: fresh })).content, "ok");
	await rm(dirname(fresh), { recursive: true, force: true });
});

test("a symlink inside scratch cannot carry a read or a write outside it", async () => {
	// 字面路径还在临时目录里，读写却顺着软链落到外面：模拟凭据被读走、外部文件被覆盖或新建。
	const target = await mkdtemp(join(tmpdir(), "ly-scratch-out-"));
	try {
		await writeFile(join(target, "credentials"), "secret");
		await mkdir(scratchDir, { recursive: true });
		await symlink(target, join(scratchDir, "out"));
		await symlink(join(target, "made-by-link"), join(scratchDir, "dangling"));
		const r = router();
		await assert.rejects(() => r.resolve("scratch://out/credentials", ctx()), /临时目录外面/);
		await assert.rejects(() => r.write("scratch://out/credentials", "overwritten", ctx()), /临时目录外面/);
		await assert.rejects(() => r.write("scratch://out/new.txt", "x", ctx()), /临时目录外面/);
		await assert.rejects(() => r.write("scratch://out/deeper/new.txt", "x", ctx()), /临时目录外面/);
		await assert.rejects(() => r.write("scratch://dangling", "x", ctx()), /临时目录外面/);
		const { readdir, readFile } = await import("node:fs/promises");
		assert.equal(await readFile(join(target, "credentials"), "utf8"), "secret");
		assert.deepEqual(await readdir(target), ["credentials"], "nothing was created outside");
	} finally {
		await rm(join(scratchDir, "out"), { force: true });
		await rm(join(scratchDir, "dangling"), { force: true });
		await rm(target, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The write boundary
// ---------------------------------------------------------------------------

test("everything except scratch is read-only", async () => {
	const r = router();
	for (const url of ["skill://pdf", "plume://addresses"]) {
		await assert.rejects(() => r.write(url, "改掉", ctx()), /只读/, `${url} must not be writable`);
	}
});

test("the router reports which schemes are writable", () => {
	const schemes = router().schemes();
	assert.deepEqual(
		schemes.filter((s) => s.writable).map((s) => s.scheme),
		["scratch"],
	);
});

// ---------------------------------------------------------------------------
// plume://
// ---------------------------------------------------------------------------

test("plume:// serves its own documentation and lists its topics", async () => {
	const doc = await router().resolve("plume://writing-skills", ctx());
	assert.match(doc.content, /description/, "the doc says what the frontmatter looks like");
	assert.equal(doc.immutable, true);

	const index = await router().resolve("plume://", ctx());
	assert.match(index.content, /- plume:\/\/writing-skills: 怎么写一个技能/, "the index shows each topic's title");
	assert.match(index.content, /- plume:\/\/ui: 界面块/, "generated topics are listed with the files");
});

test("plume://ui is built from the component catalog, even without the docs directory", async () => {
	const previous = process.env.PLUME_DOCS;
	try {
		process.env.PLUME_DOCS = join(tmpdir(), "plume-docs-missing");
		const doc = await router().resolve("plume://ui", ctx());
		assert.match(doc.content, /^# 界面块/);
		assert.match(doc.content, /\n {2}Card\(/);
	} finally {
		if (previous === undefined) delete process.env.PLUME_DOCS;
		else process.env.PLUME_DOCS = previous;
	}
});

test("plume://preview holds the page API the preview tool points at, even without the docs directory", async () => {
	const previous = process.env.PLUME_DOCS;
	try {
		process.env.PLUME_DOCS = join(tmpdir(), "plume-docs-missing");
		const doc = await router().resolve("plume://preview", ctx());
		for (const api of ["plume.send(text)", "plume.setState(value)", "plume.tweak({ label, onChange })", "<page-state>", "<design-settings>"]) {
			assert.ok(doc.content.includes(api), `${api} 不在参考里，工具描述指过来却查不到`);
		}
	} finally {
		if (previous === undefined) delete process.env.PLUME_DOCS;
		else process.env.PLUME_DOCS = previous;
	}
});

test("plume:// topics cannot reach outside the docs directory", async () => {
	for (const url of ["plume://../handlers.ts", "plume://..%2Fhandlers", "plume://a/b", "plume://nope"]) {
		await assert.rejects(() => router().resolve(url, ctx()), /没有“.*”这个主题。现有的是：.*addresses/, url);
	}
});

test("plume:// reads from PLUME_DOCS when the app points it at its bundled copy", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-docs-"));
	const previous = process.env.PLUME_DOCS;
	try {
		await writeFile(join(dir, "only.md"), "# 只有这一篇\n\n正文");
		process.env.PLUME_DOCS = dir;
		assert.equal((await router().resolve("plume://", ctx())).content, "- plume://only: 只有这一篇\n- plume://preview: 网页预览（preview）里能调用的接口\n- plume://ui: 界面块（```ui）的写法");
		assert.equal((await router().resolve("plume://only", ctx())).content, "# 只有这一篇\n\n正文");

		process.env.PLUME_DOCS = join(dir, "missing");
		await assert.rejects(() => router().resolve("plume://only", ctx()), /没有带上 Plume 的使用说明/);
	} finally {
		if (previous === undefined) delete process.env.PLUME_DOCS;
		else process.env.PLUME_DOCS = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("every plume:// doc opens with the title its index entry shows", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	const dir = fileURLToPath(new URL("../src/resources/plume-docs/", import.meta.url));
	for (const name of await readdir(dir)) {
		assert.match(name, /^[a-z0-9][a-z0-9-]*\.md$/, `${name} cannot be addressed as plume://<topic>`);
		assert.match(await readFile(join(dir, name), "utf8"), /^# \S/, `${name} must start with "# <title>"`);
	}
});

// ---------------------------------------------------------------------------
// Through the tools
// ---------------------------------------------------------------------------

test("read resolves an address, and matches reading the file directly", async () => {
	const viaAddress = await readTool.execute({ path: "skill://pdf/template.txt" } as never, toolCtx());
	assert.match(textOf(viaAddress), /模板内容/);

	const viaPath = await readTool.execute({ path: join(skillDir, "template.txt") } as never, toolCtx());
	assert.match(textOf(viaPath), /模板内容/);
});

test("ls takes a skill address, and stays inside the skill directory", async () => {
	// 这条是真实会话里的那一步：目录明明在，`ls` 却把地址拼成 `<cwd>/skill:/…` 报了找不到。
	const sub = await lsTool.execute({ path: "skill://pdf/references" } as never, toolCtx());
	assert.equal(sub.isError, undefined, textOf(sub));
	assert.match(textOf(sub), /03-guide\.md/);

	const top = await lsTool.execute({ path: "skill://pdf" } as never, toolCtx());
	assert.match(textOf(top), /^references\/$/m);
	assert.match(textOf(top), /template\.txt/);

	const climbed = await lsTool.execute({ path: "skill://pdf/../../" } as never, toolCtx());
	assert.ok(climbed.isError);
	assert.match(textOf(climbed), /技能目录外面/);
});

test("read falls through to the filesystem for a scheme nobody owns", async () => {
	const result = await readTool.execute({ path: "acme://thing" } as never, toolCtx());
	assert.ok(result.isError);
	assert.match(textOf(result), /File not found/, "it failed as a path, not as an address");
});

test("write goes to scratch through the tool, and is refused for a skill", async () => {
	const ok = await writeTool.execute({ path: "scratch://from-tool.md", content: "内容" } as never, toolCtx());
	assert.equal(ok.isError, undefined);

	const refused = await writeTool.execute({ path: "skill://pdf", content: "把技能改掉" } as never, toolCtx());
	assert.ok(refused.isError);
	assert.match(textOf(refused), /只读/);
});

test("edit takes a scratch address after write or read of the same address", async () => {
	const c = toolCtx();
	await writeTool.execute({ path: "scratch://probe.ts", content: "const size = 1;\n" } as never, c);
	const afterWrite = await editTool.execute({ path: "scratch://probe.ts", old_string: "1", new_string: "2" } as never, c);
	assert.equal(afterWrite.isError, undefined, textOf(afterWrite));

	// Made by a command rather than `write`: nothing has been seen yet, and a read of the address is what fixes that.
	await writeFile(join(scratchDir, "made-by-bash.ts"), "let x = 1;\n");
	const unread = await editTool.execute({ path: "scratch://made-by-bash.ts", old_string: "1", new_string: "2" } as never, c);
	assert.ok(unread.isError);
	await readTool.execute({ path: "scratch://made-by-bash.ts" } as never, c);
	const afterRead = await editTool.execute({ path: "scratch://made-by-bash.ts", old_string: "1", new_string: "2" } as never, c);
	assert.equal(afterRead.isError, undefined, textOf(afterRead));
	assert.equal(await readFile(join(scratchDir, "made-by-bash.ts"), "utf8"), "let x = 2;\n");
});

// ls 和 preview 以前把 `scratch://` 当成相对路径，拼成 `<cwd>/scratch:/`，永远找不到。
test("ls lists a scratch address as the scratch directory", async () => {
	const c = toolCtx();
	await writeTool.execute({ path: "scratch://listed/page.html", content: "<h1>hi</h1>" } as never, c);
	const top = await lsTool.execute({ path: "scratch://" }, c);
	assert.equal(top.isError, undefined, textOf(top));
	assert.match(textOf(top), /^listed\/$/m);
	const inner = await lsTool.execute({ path: "scratch://listed" }, c);
	assert.match(textOf(inner), /^page\.html {2}\(/m);
});

test("ls of a scratch address that leaves through a symlink is refused with the reason", async () => {
	const target = await mkdtemp(join(tmpdir(), "ly-scratch-ls-out-"));
	try {
		await symlink(target, join(scratchDir, "ls-out"));
		const result = await lsTool.execute({ path: "scratch://ls-out" }, toolCtx());
		assert.ok(result.isError);
		assert.match(textOf(result), /临时目录外面/);
	} finally {
		await rm(join(scratchDir, "ls-out"), { force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test("a preview or browser page given a scratch address opens that file", async () => {
	await writeFile(join(scratchDir, "todo.html"), "<h1>todo</h1>");
	const page = await readLocalPageFor(toolCtx(), "scratch://todo.html");
	assert.ok("content" in page, "error" in page ? page.error : "");
	assert.equal(page.content, "<h1>todo</h1>");
});

test("a session with no router reads addresses as ordinary paths", async () => {
	const bare = { cwd: root, sessionId: "s", state: new Map() } as unknown as ToolContext;
	const result = await readTool.execute({ path: "skill://pdf" } as never, bare);
	assert.ok(result.isError, "no router means no address space, and it fails as a path would");
});

// ---------------------------------------------------------------------------
// The shared guard
// ---------------------------------------------------------------------------

test("resolveInside uses path.relative rather than string prefixes", () => {
	assert.ok(resolveInside("/a/b", "c/d"));
	assert.equal(resolveInside("/a/b", "../x"), null);
	assert.equal(resolveInside("/a/b", "/etc/passwd"), null, "an absolute path is never inside");
	/*
	 * The case a prefix comparison gets wrong: `/a/bc` starts with the string `/a/b` but is not
	 * under it. `plugins/loader.ts` carries the note from when this was written that way.
	 */
	assert.equal(resolveInside("/a/b", "../bc/d"), null);
});

// ---------------------------------------------------------------------------
// agent://
// ---------------------------------------------------------------------------

/** Only the two methods the handler uses, holding one finished run. */
function registryWith(record: Record<string, unknown>) {
	return {
		list: () => [{ id: "s1:sub:a1b2c3d4", agent: "explore", description: "找登录", status: "done" }],
		detail: (id: string) => (id === "s1:sub:a1b2c3d4" ? record : null),
	};
}

const FINISHED = {
	id: "s1:sub:a1b2c3d4",
	agent: "explore",
	status: "done",
	answer: "渲染过的文本",
	output: {
		summary: "登录分三段。",
		files: [
			{ path: "src/auth/login.ts:42", why: "入口" },
			{ path: "src/db/users.ts", why: "查用户" },
		],
	},
};

function agentCtx(record: Record<string, unknown> = FINISHED): ResourceContext {
	const map = state();
	map.set("subAgentRegistry", registryWith(record));
	return { cwd: root, sessionId: "s1", scratchDir, state: map };
}

test("agent:// returns the whole structured result", async () => {
	const resource = await router().resolve("agent://s1:sub:a1b2c3d4", agentCtx());
	assert.match(resource.content, /登录分三段/);
	assert.equal(resource.contentType, "application/json");
});

test("a field path takes one value out, as a bare string", async () => {
	/*
	 * The point of the whole scheme: in an orchestration with eight sub-agents, a parent that wants
	 * one path re-reads eight whole replies to get eight values.
	 */
	const resource = await router().resolve("agent://s1:sub:a1b2c3d4/files.0.path", agentCtx());
	assert.equal(resource.content, "src/auth/login.ts:42", "no JSON quoting around a string leaf");
	assert.equal(resource.contentType, "text/plain");
});

test("an array index that is out of range is an error naming what exists", async () => {
	await assert.rejects(() => router().resolve("agent://s1:sub:a1b2c3d4/files.9.path", agentCtx()), /没有/);
});

test("a short id resolves, and still finds the structured output", async () => {
	/*
	 * The regression this pins: matching a suffix through `list()` returns a summary, which carries
	 * no `output` — so every short-form address reported "this agent returned prose" for an agent
	 * that had in fact yielded an object.
	 */
	const resource = await router().resolve("agent://a1b2c3d4/summary", agentCtx());
	assert.equal(resource.content, "登录分三段。");
});

test("an agent that returned prose hands over the prose rather than erroring", async () => {
	/*
	 * No schema is not a failure. Refusing here would send the parent looking for a way to get
	 * structured output from an agent that was never going to produce any.
	 */
	const resource = await router().resolve("agent://s1:sub:a1b2c3d4", agentCtx({ ...FINISHED, output: undefined }));
	assert.equal(resource.content, "渲染过的文本");
	assert.match(resource.label ?? "", /没有声明结构化输出/);
});

test("a session with no sub-agents says so", async () => {
	await assert.rejects(() => router().resolve("agent://whatever", ctx()), /没有子代理/);
});
