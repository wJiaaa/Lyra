// 补收口的规则挪到了 `@plume/client-runtime/stream-tail`：手机正在输出的回复也要先补上没收口的标记。
export { completeTail } from "@plume/client-runtime/stream-tail";
