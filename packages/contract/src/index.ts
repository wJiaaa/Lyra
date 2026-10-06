/**
 * The boundary between the renderer and the main process.
 *
 * See `methods.ts` for what is here and why it is one file rather than two.
 */

export { CHANNELS, METHODS, type Method } from "./methods.ts";

/**
 * 一个会话旁边最早的那个侧边聊天。
 *
 * 侧边栏点开就是它；后开的那些由界面起 id，见主进程的 `sidechat-store.ts`。
 */
export const DEFAULT_SIDE_CHAT_ID = "default";
