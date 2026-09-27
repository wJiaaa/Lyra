/**
 * The boundary between the renderer and the main process.
 *
 * See `methods.ts` for what is here and why it is one file rather than two.
 */

export { CHANNELS, METHODS, type Method } from "./methods.ts";
export { WEB_METHODS } from "./web.ts";

/*
 * `args.ts` 不在这里导出，要用它得走 `@lyra/contract/args`。
 *
 * 它需要 `node:path` 来判断绝对路径，而这个包入口是**渲染进程也会加载的**：浏览器里跑的是同一份
 * renderer，`services/host.ts` 从这里读 `WEB_METHODS`。一个 `node:` 导入混进来，Vite 会把它
 * externalize 成空壳，然后在第一次调用时炸掉整个页面。所以只有主进程走 `./args`。
 */
