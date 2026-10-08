/**
 * The dock's layout, as data.
 *
 * One tree of panes: every node is either a pane or a split holding two or more of them. There is
 * no "main area plus a side panel" here, because that division is exactly what made the old panel
 * complicated — a pane had to know whether it was beside the conversation, covering it, or full
 * screen, and three booleans had to agree about which. A tree has one answer: where you are.
 *
 * Everything in this file is pure. No React, no DOM, no storage — which is what lets the rules
 * below be stated as invariants and tested as arithmetic rather than inferred from a screenshot.
 *
 * Panes are identified by `kind`, not by a generated id. That is a consequence of invariant 2:
 * one pane per kind means the kind *is* the identity, and it saves a whole class of bug where an
 * id minted this session fails to match one that came back from storage.
 *
 * The invariants, all restored by `normalize`:
 *
 *   1. Exactly one `conversation` pane. It is the conversation; `remove` refuses to take it away.
 *   2. At most one pane per kind. Opening something already open focuses it instead.
 *   3. No split with a single child — that is the child, wearing a splitter with nothing on the
 *      other side of it.
 *   4. No split nested directly inside a split of the same axis, which would draw two handles on
 *      one boundary.
 *   5. `sizes` matches `children` in length, sums to 1, and no entry is below `MIN_FRACTION` —
 *      unless there are more children than that floor leaves room for, in which case they share
 *      the split evenly. Summing to 1 is the stronger claim, and the floor is what gives way.
 */

import type { PanelKind } from "./sideStore.ts";
import { EPSILON, MIN_FRACTION } from "./geometry.ts";

/** What can occupy a pane: any registered panel, or the conversation itself. */
export type PaneKind = PanelKind | "conversation";

export type Axis = "row" | "col";
type DropSide = "left" | "right" | "top" | "bottom";

export interface DockLeaf {
	type: "leaf";
	kind: PaneKind;
}

export interface DockSplit {
	type: "split";
	dir: Axis;
	children: DockNode[];
	/**
	 * Shares of the split's length, one per child, summing to 1.
	 *
	 * Shares rather than pixels so a window resize is a scale rather than a redistribution:
	 * pixels would have to be recomputed and re-normalised on every frame of a window drag, and
	 * the rounding error from doing that repeatedly is what makes a layout drift.
	 */
	sizes: number[];
}

export type DockNode = DockLeaf | DockSplit;

/** Where a new pane goes: against one open pane's edge. See `insertTab`. */
interface DropAt {
	side: DropSide;
	kind: PaneKind;
}

export const leafOf = (kind: PaneKind): DockLeaf => ({ type: "leaf", kind });

/** The default layout, and the one a corrupt stored tree falls back to. */
export const defaultTree = (): DockNode => leafOf("conversation");

const axisOf = (side: DropSide): Axis => (side === "left" || side === "right" ? "row" : "col");

/** True for the sides that put the new pane first in its split. */
const isLeading = (side: DropSide): boolean => side === "left" || side === "top";

/** Every pane in the tree, left to right and top to bottom. */
export function kinds(node: DockNode): PaneKind[] {
	if (node.type === "leaf") return [node.kind];
	return node.children.flatMap(kinds);
}

export const has = (node: DockNode, kind: PaneKind): boolean => kinds(node).includes(kind);

/**
 * Re-share a split's children so the sizes are a valid distribution again.
 *
 * Called after every structural change, because all of them leave the sizes wrong in some way:
 * removing a pane leaves them summing to less than 1, flattening a nested split leaves a run of
 * scaled-down shares, and a tree read back from storage may contain anything at all.
 */
function balance(sizes: number[]): number[] {
	const n = sizes.length;
	if (n === 0) return [];
	// Too many children for everyone to clear the floor: an even split is the only fair answer.
	if (n * MIN_FRACTION >= 1) return sizes.map(() => 1 / n);

	const usable = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
	const total = usable.reduce((sum, s) => sum + s, 0);
	let out = total > 0 ? usable.map((s) => s / total) : usable.map(() => 1 / n);

	/*
	 * Pinning one child to the floor takes room from the others, which can push a second one
	 * below it. Repeating settles, and cannot loop: each pass pins at least one more child, and
	 * there are only `n` of them.
	 */
	for (let pass = 0; pass < n; pass++) {
		const under = out.map((s) => s < MIN_FRACTION - EPSILON);
		const pinned = under.filter(Boolean).length;
		if (pinned === 0) break;
		const room = 1 - pinned * MIN_FRACTION;
		const free = out.reduce((sum, s, i) => sum + (under[i] ? 0 : s), 0);
		out = out.map((s, i) =>
			under[i] ? MIN_FRACTION : free > EPSILON ? (s / free) * room : room / (n - pinned),
		);
	}
	return out;
}

/**
 * Restore every invariant, bottom up.
 *
 * Returns null only for a split that lost all its children, which `remove` handles; nothing else
 * in this file can produce one.
 */
export function normalize(node: DockNode): DockNode | null {
	if (node.type === "leaf") return node;

	const children: DockNode[] = [];
	const sizes: number[] = [];

	node.children.forEach((child, i) => {
		const next = normalize(child);
		if (!next) return;
		const share = Number.isFinite(node.sizes[i]) ? node.sizes[i] : 0;
		// Invariant 4: a same-axis split is spliced into this one, its children keeping their
		// relative proportions within the share their parent held.
		if (next.type === "split" && next.dir === node.dir) {
			next.children.forEach((grand, g) => {
				children.push(grand);
				sizes.push(share * (next.sizes[g] ?? 0));
			});
			return;
		}
		children.push(next);
		sizes.push(share);
	});

	if (children.length === 0) return null;
	// Invariant 3.
	if (children.length === 1) return children[0];
	return { type: "split", dir: node.dir, children, sizes: balance(sizes) };
}

/** `normalize`, for the callers that know the tree cannot come back empty. */
const settled = (node: DockNode): DockNode => normalize(node) ?? defaultTree();

/** Put a pane beside the one named in `at`, splitting the space that one holds. */
function splice(node: DockNode, added: DockLeaf, at: DropAt): DockNode {
	const dir = axisOf(at.side);
	const leading = isLeading(at.side);

	if (node.type === "leaf") {
		if (node.kind !== at.kind) return node;
		return { type: "split", dir, children: leading ? [added, node] : [node, added], sizes: [0.5, 0.5] };
	}

	/*
	 * A split already running the right way takes the new pane as a direct sibling.
	 *
	 * Wrapping the target in a nested split would work too, and `normalize` would flatten it back
	 * to exactly this — doing it here just means the sizes are derived from the target's own share
	 * rather than reconstructed from a flatten.
	 */
	const index = node.children.findIndex((child) => child.type === "leaf" && child.kind === at.kind);
	if (index >= 0 && node.dir === dir) {
		const half = node.sizes[index] / 2;
		const children = [...node.children];
		const sizes = [...node.sizes];
		children.splice(leading ? index : index + 1, 0, added);
		sizes.splice(index, 1, half, half);
		return { ...node, children, sizes };
	}

	return { ...node, children: node.children.map((child) => splice(child, added, at)) };
}

/** Drop a pane out of the tree, leaving its siblings to re-share what it held. */
function prune(node: DockNode, kind: PaneKind): DockNode | null {
	if (node.type === "leaf") return node.kind === kind ? null : node;

	const children: DockNode[] = [];
	const sizes: number[] = [];
	node.children.forEach((child, i) => {
		const next = prune(child, kind);
		if (!next) return;
		children.push(next);
		sizes.push(node.sizes[i]);
	});
	if (children.length === 0) return null;
	// The sizes now sum to less than 1; `balance` inside `normalize` shares the gap out in
	// proportion, which is what makes a closed pane give its room to its neighbours rather than
	// to whichever one happened to be first.
	return { ...node, children, sizes };
}

/** Open a pane. Already-open kinds are left alone — invariant 2. */
export function insert(tree: DockNode, kind: PaneKind, at: DropAt): DockNode {
	if (has(tree, kind)) return tree;
	if (!has(tree, at.kind)) return tree;
	return settled(splice(tree, leafOf(kind), at));
}

/** Close a pane. The conversation is not closable — invariant 1. */
export function remove(tree: DockNode, kind: PaneKind): DockNode {
	if (kind === "conversation") return tree;
	const pruned = prune(tree, kind);
	return pruned ? settled(pruned) : tree;
}
