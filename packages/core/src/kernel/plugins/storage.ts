import { SessionStore } from "../../session/store.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { Context, Plugin } from "../context.ts";
import { STORAGE } from "../services.ts";

/**
 * Where sessions are kept.
 *
 * The default is append-only JSONL under `~/.plume`: readable with `tail`, syncable by sequence
 * number, and impossible to corrupt by half-writing a turn. It is a seam because "on this disk" is
 * an assumption, not a requirement — a hosted deployment keeps sessions per account, and a phone
 * keeps a cache of someone else's.
 */
export const storagePlugin: Plugin = {
	name: "storage",
	apply(ctx: Context) {
		return ctx.provide<SessionStorage>(STORAGE, new SessionStore());
	},
};
