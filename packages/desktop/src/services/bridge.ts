/**
 * The one place `window.plume` is named.
 *
 * Everything the renderer asks of the main process goes through this object, and it is reached
 * through `services/` rather than directly — 87 files used to name it, which made two questions
 * unanswerable without searching all of them: what does this window actually call, and what would
 * have to change to test any of it.
 *
 * `oxlint` enforces the rule (`no-restricted-properties` on `window.plume`), with this file and
 * `host.ts` exempted. A lint rule rather than a convention because the convention held for exactly
 * as long as somebody was watching.
 *
 * The object itself is built by the preload out of IPC channels.
 */

import { translate } from "../i18n/translate.ts";
import type { PlumeApi } from "../../electron/ipc-types.ts";
import { flushPushes } from "./pushes.ts";

/**
 * The bridge, or a failure that names the cause.
 *
 * A missing `window.plume` means the preload did not run, and every symptom of that is confusing:
 * blank panels, buttons that do nothing, a settings page with no settings. Better to say so.
 */
function bridgeOrThrow(): PlumeApi {
	/*
	 * `globalThis.plume` and `globalThis.window.plume` are the same object in a browser and are not in
	 * a test.
	 *
	 * The preload exposes it on `window`, which *is* `globalThis` at runtime — so either spelling
	 * works there. A unit test has no `window` until it makes one, and what it makes is an ordinary
	 * object assigned to `globalThis.window`; reading only `globalThis.plume` would miss it, and the
	 * store under test would throw at a point unrelated to what the test is about.
	 */
	const scope = globalThis as { plume?: PlumeApi; window?: { plume?: PlumeApi } };
	const api = scope.plume ?? scope.window?.plume;
	if (!api) {
		throw new Error(
			translate("bridge.missing1") +
				translate("bridge.missing2"),
		);
	}
	return api;
}

/**
 * Deliberately lazy.
 *
 * Module evaluation happens before the preload has necessarily finished, and a top-level read would
 * throw during import rather than at the call that needed it. A `Proxy` keeps the ergonomics of a
 * plain object — `bridge.sessions.list()` — while deferring the lookup to the moment of use.
 */
export const bridge: PlumeApi = new Proxy({} as PlumeApi, {
	get(_target, property) {
		const value = bridgeOrThrow()[property as keyof PlumeApi];
		if (typeof value === "function") return method(property, () => bridgeOrThrow());
		if (value && typeof value === "object") return namespace(property);
		return value;
	},
	has(_target, property) {
		return property in bridgeOrThrow();
	},
});

/*
 * Every call's reply resolves only after the pushes that arrived before it have been applied.
 *
 * Pushes are applied once per frame (`pushes.ts`), and the main process sends events and replies
 * down one pipe in order. A reply overtaking the events ahead of it is how a transcript read back
 * from disk gets the same `message_start` appended to it a second time.
 *
 * The flush is the first reaction registered on the reply, and the caller gets the same promise
 * back: reactions run in the order they were added, so it lands before the caller's `await` without
 * adding a tick. A `.finally` wrapper did the same thing two microtasks later, and that was enough
 * to let one read in `session-read.ts` overlap the next.
 *
 * Wrapped by name and looked up on every call, never captured: tests replace bridge methods after
 * the first access, and the namespaces the preload exposes are frozen, so the wrapper cannot simply
 * be the object it stands for.
 */
const namespaces = new Map<PropertyKey, object>();
const methods = new Map<string, (...args: unknown[]) => unknown>();

function namespace(property: PropertyKey): object {
	let wrapped = namespaces.get(property);
	if (!wrapped) {
		const live = () => bridgeOrThrow()[property as keyof PlumeApi] as unknown as Record<PropertyKey, unknown>;
		wrapped = new Proxy({}, {
			get(_target, name) {
				const value = live()[name];
				return typeof value === "function" ? method(`${String(property)}.${String(name)}`, live, name) : value;
			},
			has(_target, name) {
				return name in live();
			},
		});
		namespaces.set(property, wrapped);
	}
	return wrapped;
}

function method(key: PropertyKey, owner: () => object, name: PropertyKey = key): (...args: unknown[]) => unknown {
	const id = String(key);
	let wrapped = methods.get(id);
	if (!wrapped) {
		wrapped = (...args) => {
			const target = owner();
			const result: unknown = Reflect.apply(Reflect.get(target, name) as (...a: unknown[]) => unknown, target, args);
			if (result && typeof (result as PromiseLike<unknown>).then === "function") (result as PromiseLike<unknown>).then(flushPushes, flushPushes);
			return result;
		};
		methods.set(id, wrapped);
	}
	return wrapped;
}
