import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsMany, basePanelKind, nextPanelKind, panelInstance, sideIdOfPanel } from "../src/lib/panel-instance.ts";

test("后开的侧边聊天、终端按种类认，别的 kind 原样", () => {
	assert.equal(basePanelKind("chat:k1"), "chat");
	assert.equal(basePanelKind("terminal:k1"), "terminal");
	assert.equal(basePanelKind("terminal"), "terminal");
	assert.equal(basePanelKind("browser:k1"), "browser:k1", "只有能开好几个的才拆");
	assert.equal(basePanelKind("chat:"), "chat:", "没有 id 的不算");
	assert.equal(panelInstance("terminal:k1"), "k1");
	assert.equal(panelInstance("terminal"), null);
	assert.equal(sideIdOfPanel("chat"), "default");
	assert.equal(sideIdOfPanel("chat:k1"), "k1");
	assert.equal(sideIdOfPanel("terminal:k1"), null);
	assert.ok(allowsMany("chat") && allowsMany("terminal") && !allowsMany("browser"));
});

test("再开一个：最早那一格没开就是它，开着就起一个新的", () => {
	assert.equal(nextPanelKind("terminal", () => false), "terminal");
	const next = nextPanelKind("terminal", () => true);
	assert.match(next, /^terminal:[a-z0-9]+$/);
	assert.equal(basePanelKind(next), "terminal");
});
