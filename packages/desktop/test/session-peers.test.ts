/**
 * 会话之间的消息：谁看得见谁、权限比自己宽的不让发、发太快太长太绕的拦下来、忙着时排队还是插进去。
 * 等对方做完见 `peer-wait.test.ts`。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Settings } from "@plume/core";
import { peerAddress, peerName, peerRef, resolvePeer } from "../electron/peer-address.ts";
import { broaderThan, PEER_BUCKET, PeerPacer } from "../electron/peer-policy.ts";
import { rootsOverlap, sessionRoots } from "../electron/peer-reach.ts";
import { pathKey } from "../electron/path-key.ts";
import { fakeSession, routerWith } from "./helpers/peer-fake.ts";

test("地址：名字取标题、ref 取 id 前六位；ref 说了算，重名不猜", () => {
	const a = { id: "a1b2c3d4-0000-0000-0000-000000000000", title: "修登录", cwd: "/w/api" };
	const b = { id: "ffee0011-0000-0000-0000-000000000000", title: "修登录", cwd: "/w/web" };
	const c = { id: "12345678-0000-0000-0000-000000000000", title: "", cwd: "/w/docs" };
	assert.equal(peerRef(a.id), "a1b2c3");
	assert.equal(peerAddress(a), "修登录 [a1b2c3]");
	assert.equal(peerName(c), "docs", "没有标题用目录名");
	assert.equal(peerName({ title: "[草稿]\n修 bug", cwd: "/x" }), "草稿 修 bug", "方括号和换行不能混进名字");
	assert.deepEqual(resolvePeer("修登录 [a1b2c3]", [a, b, c]), { kind: "found", peer: a });
	assert.deepEqual(resolvePeer("改过名了 [ffee00]", [a, b, c]), { kind: "found", peer: b }, "名字过期了，ref 还对");
	assert.equal(resolvePeer("修登录", [a, b, c]).kind, "ambiguous");
	assert.deepEqual(resolvePeer("docs", [a, b, c]), { kind: "found", peer: c });
	assert.deepEqual(resolvePeer("123456", [a, b, c]), { kind: "found", peer: c }, "只抄了 ref 也认");
	assert.equal(resolvePeer("不存在", [a, b, c]).kind, "none");
});

test("限速：太长、链太长、自己绕圈、三十秒内同一句、发得太快", () => {
	let now = 0;
	const pacer = new PeerPacer(() => now);
	assert.equal(pacer.admit("a", "b", "x".repeat(20_001), ["a"]), "too-long");
	assert.equal(pacer.admit("a", "b", "hi", Array.from({ length: 29 }, (_, i) => `s${i}`)), "chain-runaway");
	assert.equal(pacer.admit("a", "b", "hi", [...Array(11).fill("a"), "b"]), "chain-loop");
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), null);
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), "duplicate");
	now += 30_001;
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), null, "过了窗口可以再说");
	assert.equal(pacer.admit("a", "c", "同一句", ["a"]), null, "对别人说不算重复");
	for (let i = 0; i < PEER_BUCKET; i++) pacer.admit("x", "y", `第${i}封`, ["x"]);
	assert.equal(pacer.admit("x", "y", "再来", ["x"]), "paced");
	now += 2_000;
	assert.equal(pacer.admit("x", "y", "两秒后", ["x"]), null, "两秒补一封");
	assert.equal(pacer.admit("y", "x", "反方向另算", ["y"]), null);
});

test("目录重叠：同目录、包含、p-old 不在 p 里、软链、worktree 认主工作树", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-reach-"));
	try {
		const repo = join(root, "p");
		await mkdir(join(repo, "packages", "a"), { recursive: true });
		await mkdir(join(root, "p-old"), { recursive: true });
		await mkdir(join(root, "elsewhere"), { recursive: true });
		await writeFile(join(repo, "README.md"), "x");
		const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
		run(repo, "init", "-q");
		run(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
		run(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
		const tree = join(root, "trees", "feature");
		run(repo, "worktree", "add", "-q", "-b", "feature", tree);
		await symlink(repo, join(root, "link"));

		const roots = (cwd: string, projects?: Settings["projects"]) => sessionRoots(cwd, projects);
		assert.ok(rootsOverlap(await roots(repo), await roots(join(repo, "packages", "a"))), "一个在另一个里面");
		assert.ok(!rootsOverlap(await roots(repo), await roots(join(root, "p-old"))), "p-old 不在 p 里");
		assert.ok(rootsOverlap(await roots(repo), await roots(join(root, "link"))), "软链指过去的是同一个目录");
		assert.ok(rootsOverlap(await roots(tree), await roots(repo)), "worktree 和主工作树");
		assert.ok(!rootsOverlap(await roots(tree), await roots(join(root, "elsewhere"))));
		assert.ok(!rootsOverlap(await roots(join(repo, "packages", "a")), await roots(join(root, "elsewhere"))));
		const projects = [{ id: "p", name: "p", path: repo, folders: [repo, join(root, "elsewhere")] }] as unknown as Settings["projects"];
		assert.ok(rootsOverlap(await roots(repo, projects), await roots(join(root, "elsewhere"))), "同一个项目的另一个源目录");
		assert.ok((await roots(join(root, "p-old"))).every((one) => one === pathKey(one)), "都是比较用的写法");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("权限：对方比自己宽才拦，一样宽或更窄都放", () => {
	assert.ok(broaderThan("full", "auto"));
	assert.ok(broaderThan("auto", "ask"));
	assert.ok(!broaderThan("auto", "auto"));
	assert.ok(!broaderThan("ask", "full"), "宽的请窄的做事，窄的那边照样一步步审批");
});

test("路由：列出目录重叠的、送达时带上地址和链、看不见的说清原因", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-route-"));
	try {
		await mkdir(join(root, "api", "src"), { recursive: true });
		await mkdir(join(root, "other"), { recursive: true });
		const a = fakeSession("aaaaaaaa-1", join(root, "api"));
		const b = fakeSession("bbbbbbbb-1", join(root, "api", "src"));
		const c = fakeSession("cccccccc-1", join(root, "other"));
		const { router } = routerWith(a, b, c);

		assert.deepEqual(await router.list("aaaaaaaa-1"), [{ address: "bbbb [bbbbbb]", sessionId: "bbbbbbbb-1", cwd: join(root, "api", "src"), busy: false, mode: "auto" }]);
		const sent = await router.send("aaaaaaaa-1", { to: "bbbb", message: "接着发版" });
		assert.deepEqual(sent, { kind: "delivered", to: "bbbb [bbbbbb]", busy: false, queued: false });
		const { id, ...letter } = b.inbox[0]!.letter;
		assert.match(id ?? "", /^[0-9a-f-]{36}$/, "每封信有自己的 id，等待据此钉住那一次运行");
		assert.deepEqual(letter, { sessionId: "aaaaaaaa-1", from: "aaaa [aaaaaa]", text: "接着发版", cwd: join(root, "api"), chain: ["aaaaaaaa-1"] });

		// B 读了这封再去找 A：链接上了。
		await router.send("bbbbbbbb-1", { to: "aaaa [aaaaaa]", message: "顺带问一句" });
		assert.deepEqual(a.inbox[0]?.letter.chain, ["aaaaaaaa-1", "bbbbbbbb-1"]);
		// 人在 B 那边开口之后，B 发的是一条新链。
		router.personSpoke("bbbbbbbb-1");
		await router.send("bbbbbbbb-1", { to: "aaaa", message: "新的事" });
		assert.deepEqual(a.inbox[1]?.letter.chain, ["bbbbbbbb-1"]);

		assert.equal((await router.send("aaaaaaaa-1", { to: "cccc", message: "hi" })).kind, "unreachable");
		assert.equal((await router.send("aaaaaaaa-1", { to: "aaaa", message: "hi" })).kind, "self");
		assert.equal((await router.send("aaaaaaaa-1", { to: "nobody", message: "hi" })).kind, "none");
		assert.equal((await router.wait("aaaaaaaa-1", { to: "cccc" })).kind, "unreachable", "等也一样要目录重叠");
		assert.equal(c.inbox.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("路由：对方权限比自己宽，不送；反过来照送", async () => {
	const ask = fakeSession("aaaaaaaa-2", "/w/p", "ask");
	const full = fakeSession("bbbbbbbb-2", "/w/p", "full");
	const { router } = routerWith(ask, full);
	assert.deepEqual(await router.send("aaaaaaaa-2", { to: "bbbb", message: "帮我删了它" }), { kind: "broader", to: "bbbb [bbbbbb]", theirs: "full", mine: "ask" });
	assert.equal(full.inbox.length, 0);
	assert.equal((await router.send("bbbbbbbb-2", { to: "aaaa", message: "看一眼" })).kind, "delivered");
	assert.equal(ask.inbox.length, 1);
});

test("路由：对方忙时默认排到它手上这件事之后；steer 才插进去", async () => {
	const a = fakeSession("aaaaaaaa-3", "/w/p");
	const b = fakeSession("bbbbbbbb-3", "/w/p");
	const { router } = routerWith(a, b);
	assert.deepEqual(await router.send("aaaaaaaa-3", { to: "bbbb", message: "闲着时" }), { kind: "delivered", to: "bbbb [bbbbbb]", busy: false, queued: false });
	b.start();
	assert.deepEqual(await router.send("aaaaaaaa-3", { to: "bbbb", message: "接着发版" }), { kind: "delivered", to: "bbbb [bbbbbb]", busy: true, queued: true });
	assert.deepEqual(await router.send("aaaaaaaa-3", { to: "bbbb", message: "先别动 config.ts", steer: true }), { kind: "delivered", to: "bbbb [bbbbbb]", busy: true, queued: false });
	assert.deepEqual(b.inbox.map((one) => one.deliver), ["followUp", "followUp", "steer"]);
});
