import { SessionStore } from "../../session/store.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { Context, Plugin } from "../context.ts";
import { STORAGE } from "../services.ts";

/**
 * Where sessions are kept.
 *
 * The default is one SQLite database under `~/.plume/sessions`: append-only records read back by
 * sequence number, written a transaction at a time. It is a seam because "on this disk" is an
 * assumption, not a requirement — a hosted deployment keeps sessions per account.
 */
export const storagePlugin: Plugin = {
	name: "storage",
	apply(ctx: Context) {
		return ctx.provide<SessionStorage>(STORAGE, new SessionStore());
	},
};
