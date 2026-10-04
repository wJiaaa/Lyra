/**
 * How the renderer talks to the main process.
 *
 * One import for callers: `import { bridge } from "@/services"`. The two files behind it answer
 * different questions — `bridge.ts` is *how* (and the only place `window.plume` is named),
 * `host.ts` is *whether* (which methods answer in this host, and why not when they do not).
 */

export { bridge } from "./bridge.ts";
export { available, hostPlatform, onPhone } from "./host.ts";
