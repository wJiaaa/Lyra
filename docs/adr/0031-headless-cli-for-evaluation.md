# ADR-0031：评测用的非交互命令行，同一个运行时、桌面端的设置

- 状态：已采纳
- 日期：2026-09-28
- 相关：`packages/cli/src/{main,run}.ts`；`packages/core/src/kernel/host.ts`（`bootHostKernel`、`registerDefaultSearchProviders`）、`commands/catalogue.ts`（`listCommands`）、`commands/invoke.ts`（`resolveInvocation`）；desktop `electron/main.ts`、`electron/commands-service.ts`、`src/features/composer/outgoing.ts`

## 背景

用户原话：「这个 cli 是给评测用的。能工作就行了，不需要太多的交互」「只做一个非交互模式吧」。

评测要的是：给一个任务、不管中途、拿回答和退出码，事后能看轨迹。要测的是产品本身，所以不能是第二套实现。

## 决定

1. **只有非交互模式。** `plume [-C 目录] [--json] <任务>`，任务也可以从 stdin 读。stdout 只有回答（`--json` 时是一个含 `status`、`answer`、`error`、`sessionId`、`usage` 的对象），进度（工具调用、失败、拒绝、提示、重试）一行一条写 stderr。退出码 0 跑完、1 没跑完（出错、停止、到轮数上限、卡住）、2 用法或设置有误。
2. **同一个运行时、同一份设置。** 直接驱动 core 的 `AgentSession`，读 `~/.plume`：模型、密钥、权限模式、MCP、skill 都在桌面端配。内核启动（插件、能力插件、各个接缝）从 `electron/main.ts` 挪到 core 的 `bootHostKernel`，命令目录（`listCommands`）和 `/命令`、`/skill` 的展开（`resolveInvocation`）也挪进 core，桌面端和命令行各调一次，不各写一份。
3. **没人能批的就当场拒绝。** 授权请求在事件里立刻以 `reject` 回复（允许跳过的提问用 `skip`），并在 stderr 记一行。等下去只会耗掉评测的时间、最后还是拒绝。一次运行允许做什么，由桌面端的权限模式决定。
4. **跑在 Node 24 上。** core 本来就能被 Node 直接执行（去类型），不需要打包，也不需要 Bun。
5. **运行照常存成会话。** 桌面端可以打开看轨迹，和人手动跑的没有区别。

## 没有做的

- **不做交互式终端界面。** 曾经用 OpenTUI 做过一版，它需要 Bun（Node 24 没有 FFI），评测也用不上，删掉了。
- **命令行不提供配置。** 没有改模型、改权限的参数；要换就在桌面端改，避免两处配置对不上。

## 后果

- 评测脚本只需要看退出码和 stdout；要细节就加 `--json`，或者用 `sessionId` 在桌面端打开这次会话。
- 权限模式设得太紧，任务会因为被拒而做不完；这种情况在 stderr 有 `⚑ 拒绝` 记录，可以直接查到。
