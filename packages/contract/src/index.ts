/**
 * The boundary between the renderer and the main process.
 *
 * See `methods.ts` for what is here and why it is one file rather than two.
 */

export { CHANNELS, METHODS, type Method } from "./methods.ts";
export { WEB_METHODS } from "./web.ts";

/**
 * 一个会话旁边最早的那个侧边聊天。
 *
 * 一个会话能开好几个侧边聊天之前，它就是唯一那一个，存档是 `sidechats/<会话>.json`。它留在原处、
 * 叫这个 id，旧存档不用搬；后开的那些由界面起 id，见主进程的 `sidechat-store.ts`。
 */
export const DEFAULT_SIDE_CHAT_ID = "default";

/*
 * `args.ts` 不在这里导出，要用它得走 `@plume/contract/args`。
 *
 * 它需要 `node:path` 来判断绝对路径，而这个包入口是**渲染进程也会加载的**：浏览器里跑的是同一份
 * renderer，`services/host.ts` 从这里读 `WEB_METHODS`。一个 `node:` 导入混进来，Vite 会把它
 * externalize 成空壳，然后在第一次调用时炸掉整个页面。所以只有主进程走 `./args`。
 */
