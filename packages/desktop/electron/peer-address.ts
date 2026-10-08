/**
 * 会话的地址：`名字 [ref]`。
 *
 * 名字取会话标题，会变、会重名；ref 取 id 的前六位，不变。所以解析时 ref 说了算：模型拿着一个
 * 改名之前抄下的地址来，名字对不上、ref 对得上，照样送到。重名又没带 ref 的，不猜，把候选列
 * 出来让它挑——猜错一次就是把活交给了另一个项目里的会话。
 */

import { basename } from "node:path";

export interface PeerIdentity {
	id: string;
	title: string;
	cwd: string;
}

const REF = /^(.*?)\s*\[([0-9a-f]{6,12})\]$/i;

export function peerRef(id: string): string {
	return id.replace(/-/g, "").slice(0, 6).toLowerCase();
}

/** 标题压成一行；方括号换掉，免得名字本身被读成 ref。 */
export function peerName(peer: Pick<PeerIdentity, "title" | "cwd">): string {
	const name = peer.title.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
	return name || basename(peer.cwd) || "session";
}

export function peerAddress(peer: PeerIdentity): string {
	return `${peerName(peer)} [${peerRef(peer.id)}]`;
}

export type Resolution<T extends PeerIdentity> =
	| { kind: "found"; peer: T }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: T[] };

export function resolvePeer<T extends PeerIdentity>(to: string, peers: readonly T[]): Resolution<T> {
	const wanted = to.trim();
	const parsed = REF.exec(wanted);
	if (parsed) {
		const ref = parsed[2]!.toLowerCase();
		const hits = peers.filter((peer) => peer.id.replace(/-/g, "").toLowerCase().startsWith(ref));
		return pick(hits);
	}
	const byName = peers.filter((peer) => peerName(peer) === wanted);
	if (byName.length > 0) return pick(byName);
	// 只写了 ref 的也认：那是从列表里抄的，不会是别的意思。
	if (/^[0-9a-f]{6,12}$/i.test(wanted)) return pick(peers.filter((peer) => peer.id.replace(/-/g, "").toLowerCase().startsWith(wanted.toLowerCase())));
	return { kind: "none" };
}

function pick<T extends PeerIdentity>(hits: T[]): Resolution<T> {
	if (hits.length === 1) return { kind: "found", peer: hits[0]! };
	if (hits.length === 0) return { kind: "none" };
	return { kind: "ambiguous", candidates: hits };
}
