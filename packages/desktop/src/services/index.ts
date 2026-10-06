/**
 * How the renderer talks to the main process.
 *
 * One import for callers: `import { bridge } from "@/services"`. The two files behind it answer
 * different questions — `bridge.ts` is *how* (and the only place `window.plume` is named),
 * `host.ts` is *where* (which system the desktop runs, readable during render without a bridge).
 */

export { bridge } from "./bridge.ts";
export { hostPlatform } from "./host.ts";
