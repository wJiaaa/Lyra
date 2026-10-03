# ADR-0034：循环的配置分成四组，每个字段只属于一组

- 状态：已采纳
- 日期：2026-10-03
- 相关：`packages/core/src/agent/{run-config,loop,stream-turn,tool-run,compact-step}.ts`；`packages/core/src/runtime/{turn-config,session-turn,sub-agent,sidechat,hooks,tool-policy}.ts`；`packages/core/test/run-config.ts`

## 背景

`AgentRunConfig` 原来是一个扁平对象，四十来个字段，承担了五种职责：对话输入、模型请求、循环控制、
工具执行环境、钩子。具体的毛病：

- **十四个字段只是路过。** `cwd`、沙箱策略、`allowedPaths`、`spawnSubAgent`……loop 一个都不读，
  `tool-run.ts` 再逐行抄回 `ToolContext`。给工具加一个上下文字段要改三处，外加每个构造方；漏掉一处
  不报错，`tool-policy.ts` 顶上记着的那次就是子代理少拿了沙箱策略，在会话选定的沙箱之外跑命令。
- **runtime 借它当类型字典。** 钩子签名、工具策略、请求替身都写成 `AgentRunConfig["beforeToolCall"]`、
  `Pick<AgentRunConfig, …>`，runtime 自己的概念住在 loop 的契约里。
- **换模型复制整份配置。** `run.active = { ...config, provider, model }` 为了换两个字段复制四十个；
  `streamTurn` 拿到整份，只用其中十来个。
- **它是插件缝的公开契约。** `useAgentLoop` 的替换实现接的就是它，加的每个字段都成了那条缝的 API。

## 决定

1. **`AgentRunConfig` 只有四个键**：`session`、`model`、`tools`、`control`。按消费方分组：
   `stream-turn` 只读 `model`，`tool-run` 只读 `tools`，历史相关的代码（压缩、剪枝、日期块）只读
   `session`，loop 是编排者，四组都读。
2. **一个字段只属于一组。** 好几处都要用的句柄（停止信号、会话状态图、会话 id）归一组，由 loop 当
   参数交给别处（`StreamScope`、`ToolRunScope`、`compactStep` 的 `signal`）。语义和消费方不一致时
   按消费方定：`transcript` 是会话历史，但只有工具读，归 `tools.env`；`cacheKey` 是请求参数，归 `model`。
3. **组内字段一律必填，值可以是 `undefined`。** 例外只有四个有通用默认值的数：`maxTurns`、
   `maxTokens`、`temperature`、`retryAttempts`。构造方必须写出每个字段，哪怕写的是「不给」。
4. **`tools.env` 由 `ToolContext` 推导**（`ToolEnvironment`），`tool-run` 整体展开，再补上按次的部分
   （会话 id、信号、状态图、包过一层的审批、进度回调）。给工具加上下文字段时，三处构造都会编译失败。
5. **钩子和替身有自己的名字**：`BeforeToolCall`、`AfterToolCall`、`PermissionRequestHook`、
   `StopHook`、`StreamFn`。runtime 依赖这些名字，不再写 `AgentRunConfig["…"]`。
6. **`StreamRequest` 保留**，作为 `model` 组收窄到单个请求、再加上停止信号之后交给替身的形状。
7. **守卫写在 `src/` 里。** core 的 `tsc` 只查 `src/`，所以「恰好四组」「组间没有同名字段」是
   `run-config.ts` 里的两条编译期断言。测试统一经 `test/run-config.ts` 的 `runConfig()` 构造。

一次迁完：旧的顶层字段、按旧形状读写的代码、转换函数一个都不留。

## 没有做的

- **`tools` 组里没有再分出 `policy` 子块。** 子代理继承的是 `toolPolicy()` 的产出，展开进
  `env` 已经看得出来；再套一层，`tool-run` 又得把它摊平回 `ToolContext`，逐字段抄写会回来。
- **没有处理 `agent/` 对 `runtime/` 的反向依赖。** loop 仍然导入 `runtime/` 下的剪枝、压缩生命周期、
  换模型等模块，`run-config.ts` 的类型也引用了 `AgedToolPruner`、`ArtifactSink`。这是目录分层的问题，
  和配置的形状无关，要做就单独做：把只给 loop 用的机制挪进 `agent/`，再加一条依赖规则。

## 后果

- 给任何一组加字段都要回答「归哪组」，否则编译期断言或构造方会报错。
- 侧聊这类几乎什么都不给的运行，构造里有一长串 `undefined`。这是有意的：「不给沙箱」是一个决定，
  写出来才看得见。
- 替换 loop 的插件（`useAgentLoop`）要按四组读配置，没有兼容层。
