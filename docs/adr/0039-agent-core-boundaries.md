# ADR-0039：循环不依赖 runtime，会话只管谁占着历史

- 状态：已采纳
- 日期：2026-10-02
- 相关：[ADR-0034](0034-run-config-in-four-groups.md)（循环的拆分与四组配置）；`packages/core/src/agent/`；`packages/core/src/runtime/{session,session-activity,session-deliveries,session-lookup}.ts`；`packages/core/src/tokens.ts`；`.dependency-cruiser.cjs`（`loop-sits-below-the-session`）

## 背景

2026-10-02 对 agent 核心做了一次架构评审，故障恢复和停止策略打分很高，扣分集中在结构上。`runAgent`
过长、配置是扁平大对象这两条，已由 ADR-0034 的拆分与四组配置解决；剩下的是：

- 循环 import 了 `runtime/` 下七个模块，而 `runtime/` 是驱动循环的那一层。
- `AgentSession` 用八个字段隐式表达「谁占着历史」：`acceptingPrompt`、`activePrompt`、
  `pendingResume`、`controller`、`activeTurn`、`compactionTask`、`abortEpoch`、`steerable`。
  合法的组合没有写在任何地方，其中一处是错的：提问和开场消息续跑共用 `acceptingPrompt`，
  先结束的那个会把会话标成空闲，而另一个还占着历史。
- `session.ts` 文件头记着上一次为什么不再拆：剩下的代码都要同时借 `log`、`settings`、`emit`、
  `controller` 中的三四样，要再拆，「得先让那五样核心状态之间的关系变简单」。

## 决定

**循环不 import `runtime/`、`session/`、`kernel/`，由 arch 规则守。** 查下来，循环从 `runtime/`
拿的没有一样真的属于上层：剪枝、换模型摘句柄是循环自己对历史做的事，挪进 `agent/`；token 算术
挪进本来就是叶子的 `tokens.ts`；两组类型挪进 `types/`。所以是挪位置，不是加注入。

**谁占着历史由 `SessionActivity` 管。** 一次提问或续跑是一个 hold（在第一行执行之前就占位），
hold 里面跑 turn，手动压缩单独占；`stop` 打一个标记，等过东西的代码对一下标记再动手。提问与续跑
各自记账，修掉了共用一个布尔值的那个问题。后台结果的攒批送回（`SessionDeliveries`）只借四样东西，
`session://` 的数据源（`session-lookup.ts`）只借 store，两者都搬了出去。

## 没有做的

- **`session.ts` 仍有一千一百多行。** 手动压缩、编辑重发、换模型、项目配置叠加都要同时借
  `log`、`settings`、`emit`、`can` 中的三四样。按真实边界能拆的已经拆了；剩下的硬拆，协作者就要
  收十几个回调。
- **进程级的缝（`useAgentLoop`、`useToolPipeline`、`useCompaction` 等十条）没有改成逐会话注入。**
  桌面端和命令行各自只启动一个内核，`node --test` 每个文件一个进程，14 个绑定这些缝的测试文件
  都成对复位。没有观测到它造成的缺陷，改成注入要动四五十个文件。哪天一个进程里需要两套内核
  （比如同进程跑两个不同插件配置的评测），再改。
- **`ai/` 里的 `learned` 表保持进程级。** 它们记的是「这个端点不收某个参数」这类关于远端的事实，
  对进程里的每个会话都成立，是缓存，不是配置。

## 验证

core 全部测试通过；`pnpm audit:sessions` 在本机真实会话上改前改后输出逐字节相同；
`session-activity.test.ts` 覆盖了占位时机、提问与续跑重叠、停止标记、压缩生命周期。循环依赖基线
不变（118）。
