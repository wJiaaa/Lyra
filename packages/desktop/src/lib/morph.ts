/**
 * Make `target`'s children what `source`'s are, touching only what differs.
 *
 * For a page drawn while it is being written: each new piece of markup is a new parse, and putting
 * that parse in wholesale rebuilt every element on every update — images reloaded, animations
 * started over, the page flickered a few times a second. A page being written mostly grows at its
 * end, so walking the two trees in step leaves nearly everything where it is and only appends.
 *
 * Positional, not keyed: an element that changed its tag is replaced, its subtree with it. That is
 * the rare case here — the markup already written does not change — and keys would cost a lookup
 * per node on every update for it.
 */
export function morph(target: Element, source: Element): void {
	syncAttributes(target, source);
	morphChildren(target, source);
}

function morphChildren(target: Node, source: Node): void {
	const document = target.ownerDocument ?? (target as Document);
	const wanted = source.childNodes;
	for (let index = 0; index < wanted.length; index++) {
		const next = wanted[index]!;
		const have = target.childNodes[index];
		if (!have) {
			target.appendChild(document.importNode(next, true));
			continue;
		}
		if (have.nodeType !== next.nodeType || have.nodeName !== next.nodeName) {
			target.replaceChild(document.importNode(next, true), have);
			continue;
		}
		if (next.nodeType === 1) morph(have as Element, next as Element);
		else if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue;
	}
	while (target.childNodes.length > wanted.length) target.lastChild!.remove();
}

function syncAttributes(target: Element, source: Element): void {
	// A copy: `attributes` is live, and removing from it while walking it skips the next one.
	for (const attribute of Array.from(target.attributes)) {
		if (!source.hasAttributeNS(attribute.namespaceURI, attribute.localName)) target.removeAttributeNS(attribute.namespaceURI, attribute.localName);
	}
	for (const attribute of source.attributes) {
		if (target.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value) target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
	}
}
