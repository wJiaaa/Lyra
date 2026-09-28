/**
 * How the renderer talks to the main process.
 *
 * One import for callers: `import { bridge } from "@/services"`. The two files behind it answer
 * different questions — `bridge.ts` is *how* (and the only place `window.plume` is named),
 * `host.ts` is *where* (an Electron window or a browser through Web access, which methods answer
 * there, and which system the desktop runs).
 */

export { bridge } from "./bridge.ts";
export { available, hostPlatform, onWeb } from "./host.ts";
