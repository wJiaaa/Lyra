/**
 * Which of this machine's addresses to offer as Web access links.
 *
 * A development machine holds several and they are indistinguishable by shape: Docker's bridge,
 * a VPN's tun, VirtualBox's host-only adapter and the actual Wi-Fi address are all private IPv4.
 * The first link in the list is the one people open, so picking wrong does not produce an
 * error — it produces a link that looks right and a page that times out, which is the hardest
 * kind of failure to attribute.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { rankAddresses, type InterfaceEntry } from "../electron/web-server.ts";

/** One interface entry, with the fields the ranking actually reads. */
function ipv4(address: string, internal = false): InterfaceEntry {
	return { address, family: "IPv4", internal };
}

const addressesWith = (interfaces: Record<string, InterfaceEntry[]>): string[] => rankAddresses(interfaces);

test("the Wi-Fi address comes before Docker's bridge", () => {
	const found = addressesWith({
		docker0: [ipv4("172.17.0.1")],
		en0: [ipv4("192.168.1.188")],
	});
	assert.deepEqual(found, ["192.168.1.188", "172.17.0.1"]);
});

test("virtual adapters go last however plausible their address looks", () => {
	// `192.168.x` on a VirtualBox adapter is the trap: it outranks everything by address alone.
	const found = addressesWith({
		vboxnet0: [ipv4("192.168.56.1")],
		"vEthernet (WSL)": [ipv4("172.20.0.1")],
		en0: [ipv4("10.0.0.42")],
	});
	assert.equal(found[0], "10.0.0.42", "the real interface leads");
	assert.deepEqual(found.slice(1).sort(), ["172.20.0.1", "192.168.56.1"]);
});

test("Mihomo's fake-IP network cannot outrank the Wi-Fi address", () => {
	const found = addressesWith({
		Mihomo: [ipv4("198.18.0.1")],
		WLAN: [ipv4("172.17.9.120")],
	});
	assert.deepEqual(found, ["172.17.9.120", "198.18.0.1"]);
});

test("the benchmarking range stays last even under an unfamiliar adapter name", () => {
	const found = addressesWith({
		"Local Area Connection 9": [ipv4("198.19.4.2")],
		WiFi: [ipv4("10.0.0.42")],
	});
	assert.deepEqual(found, ["10.0.0.42", "198.19.4.2"]);
});

test("loopback and link-local are not addresses anything can connect on", () => {
	// 169.254.x is what an interface assigns itself when DHCP never answered — a symptom of no
	// network, and it would otherwise sort above a Docker bridge.
	const found = addressesWith({
		lo0: [ipv4("127.0.0.1", true)],
		en1: [ipv4("169.254.12.9")],
		en0: [ipv4("192.168.1.5")],
	});
	assert.deepEqual(found, ["192.168.1.5"]);
});

test("the same address on two aliases is listed once", () => {
	const found = addressesWith({
		en0: [ipv4("192.168.1.5"), ipv4("192.168.1.5")],
	});
	assert.deepEqual(found, ["192.168.1.5"]);
});

test("a machine with only a virtual adapter can still be reached on it", () => {
	// Ranked last, not dropped: someone whose only route to the other device genuinely is a bridge
	// should be able to choose it rather than be told there is no address at all.
	const found = addressesWith({ docker0: [ipv4("172.17.0.1")] });
	assert.deepEqual(found, ["172.17.0.1"]);
});

test("no usable interface is an empty list, not a crash", () => {
	const found = addressesWith({ lo0: [ipv4("127.0.0.1", true)] });
	assert.deepEqual(found, []);
});
