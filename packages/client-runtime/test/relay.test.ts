import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalizeConnection, pairingCode, parsePairingCode } from "../src/connection.ts";
import { relayRoom, relaySocketUrl, sha256Hex } from "../src/relay.ts";

const node = (text: string) => createHash("sha256").update(text).digest("hex");

test("手写的 SHA-256 与 node:crypto 一致，包括填充边界附近的长度", () => {
	// 55、56、64 字节正好卡在「长度能不能塞进最后一块」的边界上，手写实现最容易在这里错。
	for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "令牌🙂", "f".repeat(64)]) {
		assert.equal(sha256Hex(text), node(text), `length ${text.length}`);
	}
});

test("房间号由令牌加前缀派生，桌面与手机算出同一个值，且不等于令牌的裸哈希", () => {
	const token = "a".repeat(64);
	assert.equal(relayRoom(token), node(`plume-relay\0${token}`));
	assert.notEqual(relayRoom(token), node(token));
	assert.match(relayRoom(token), /^[a-f0-9]{64}$/);
});

test("中转地址：裸主机默认 wss，http 降为 ws，路径保留，带凭据或查询的拒绝", () => {
	assert.equal(relaySocketUrl("relay.example.com"), "wss://relay.example.com");
	assert.equal(relaySocketUrl("https://relay.example.com/"), "wss://relay.example.com");
	assert.equal(relaySocketUrl("http://127.0.0.1:8787"), "ws://127.0.0.1:8787");
	assert.equal(relaySocketUrl("wss://h.example.com:9000/plume/"), "wss://h.example.com:9000/plume");
	for (const bad of ["", "  ", "ftp://host", "https://u:p@host", "https://host/?x=1", "https://host/#a"]) assert.equal(relaySocketUrl(bad), null, bad);
});

test("中转配对码往返不丢「经中转」这一点，直连码保持原样", () => {
	const relay = normalizeConnection("https://abc.trycloudflare.com", " tok ", true);
	assert.deepEqual(relay, { url: "wss://abc.trycloudflare.com", token: "tok", relay: true });
	assert.match(pairingCode(relay), /^plume:\/\/pair\?relay=/);
	assert.deepEqual(parsePairingCode(pairingCode(relay)), relay);
	const direct = normalizeConnection("192.168.1.2:4517", "tok");
	assert.equal(direct.relay, undefined);
	assert.deepEqual(parsePairingCode(pairingCode(direct)), direct);
	assert.throws(() => normalizeConnection("", "tok", true));
});
