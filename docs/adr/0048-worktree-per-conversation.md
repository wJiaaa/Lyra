# ADR-0048：工作树按会话选，算在原项目名下

- 状态：已采纳
- 日期：2026-10-14（移植自上游 kittors/Lyra main 的 ADR-0038，v0.9.27 之后）
- 相关：core `session/types.ts`（`SessionMeta.worktree`）、`config/settings.ts`（`worktrees`）；desktop
  `electron/create-session.ts`、`electron/prompt-input.ts`（`initialPrompt`）、`electron/git-worktrees.ts`
  （`autoCreateSessionWorktree`）、`electron/session-hub.ts`、`electron/i18n.ts`（`worktree.notCreated`）、
  `src/ui/inputs/WorktreeToggle.tsx`、`src/features/conversation/SessionStatus.tsx`、`src/lib/session-home.ts`、
  `src/store/session-workspace.ts`、`src/lib/sidebar-grouping.ts`；测试 `test/git-worktrees.test.ts`、
  `test/create-session.test.ts`、`test/sidebar-grouping.test.ts`、`test/ui/worktree-toggle.test.ts`、
  `test/ui/worktree-conversation.test.ts`

## 背景

开新会话时没法「这一次」选要不要工作树，只能在设置里一次定下以后所有会话都开；开了之后侧栏里会多出一个
同名的项目。查下来是几处各管一段、互相没接上：

- 只有一个全局开关。建会话时按它打 `workspaceSetup` 标记，首条消息激活时 `autoCreateSessionWorktree` **又问一遍**
  开关——即使界面上能选，选了也会被设置推翻。
- 会话的 `cwd` 改成了工作树。侧栏按 `cwd` 分组，那个路径不属于任何登记过的项目，于是每开一个工作树会话就多一个
  同名的项目文件夹，会话行在工作树建好的那一刻从原项目下跳过去；打开它时项目 chip 是工作树的文件夹名，从它开
  新会话会在工作树里再套一棵。
- 建失败时悄悄回到项目目录里跑，标记照样清掉——要了副本的人改的是自己的检出。

工作树建在哪的问题本仓库已经在 `6c26f11c` 里收过：留空就放 `~/.plume/worktrees`，Git 面板的守卫和创建读同一个
`resolveWorktreesRoot`。这次没有再动它。

## 决定

**一、按会话选，设置只是默认。** 新会话（还没发第一条、项目是 Git 仓库）的输入框上，项目和分支后面有一个开关
（`WorktreeToggle`，⑂ 加「工作树」，开着是强调色，样子照计划模式那颗）。它从 `worktrees.autoCreateOnNewSession`
起步，选的结果随首条消息走 `initial.worktree`（`initialPrompt` 白名单收它），`createStoredSession` 按它打标记。
`autoCreateSessionWorktree` 不再问设置：标记就是决定。定时任务没有输入框，`getOrCreateSession` 那条路按设置决定。

开关挂在草稿上（`draftKey`）：换一个新会话、或者这个新会话换了项目，就回到设置的默认值。会话跑起来以后开关消失
——那时已经挪不进副本了。

**二、记下它出自哪个项目。** 建好之后 `SessionMeta.worktree = { project, branch }`。凡是「这个会话属于哪个项目」
的问题都先问它（`sessionHome`）：侧栏分组、「已清空的项目」、归档页、项目菜单的会话数、「归档这个项目的会话」、
会话菜单里「移到项目」标当前项、行的拖动排序、悬停卡片上的项目名。复制路径、跑命令仍然用 `cwd`——文件在那里。

> 后来项目改成按 id 认（[ADR-0053](0053-project-is-an-id.md)），一个文件夹可以在好几个项目里，「属于哪个项目」改为只看会话记下的 `SessionMeta.project`。
> 上面这些问题不再经过 `worktree.project`；它仍然说明工作树出自哪个检出，新会话回到那里（`projectWorkspace`）。

打开这样的会话，窗口的 `workspace` 仍是工作树（分支、改动、文件都是它的），名字取原项目、带上 `worktreeOf`
（`sessionWorkspace`）。从它开新会话回到原项目（`projectWorkspace`，分支随后重读）。侧栏上它空闲时行首画 ⑂、
悬停说分支；在跑、等审批、未读这些状态照旧优先。

`worktreeOf` 只由渲染进程按会话的 meta 填，主进程的 `workspace.info` 不猜：一棵人自己建、又作为项目打开的工作树
是一个独立的项目，不该被改名成主仓库。

**三、项目是仓库的子目录时，会话落在工作树里的同一个子目录**；那个子目录没提交过（副本里没有）就落在工作树根。

**四、建不出来要说。** 回到项目目录里跑之前，对话里出一条提示（`worktree.notCreated`），带上原因。
（已被 ADR-0050 取代：原因记在会话上，输入框上一直有一个提醒。）

## 没做的

- 改之前建出来的工作树会话没有 `worktree` 字段，仍在各自的分组里。要归位得做一次迁移（从 `cwd` 的 `.git` 指针认出
  主仓库），没有放在这次。
- 生命周期：删除或归档会话不回收它的工作树；没有「合并回主分支」「同步基分支」「选基分支」。（后来做了除「选基分支」
  以外的部分，见 ADR-0050。）
- 手机上没有这个开关：手机开的新会话照设置。
