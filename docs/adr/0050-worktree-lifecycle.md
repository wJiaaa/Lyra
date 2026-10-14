# ADR-0050：工作树的后半生——收回、检出回来、合回去、同步进来

- 状态：已采纳
- 日期：2026-10-14
- 来源：移植上游 kittors/Lyra 的 `790c1639`、`2396c47b`、`afcd1ae6`（上游 ADR-0040）；上游同批的 `3c065249`
  （改版前建在仓库旁边的工作树会话启动时归位）没有移植，见「没做的」
- 相关：desktop `electron/worktree-lifecycle.ts`（`worktreeState`、`reclaimWorktree`、`restoreWorktree`、
  `bringBackWorktree`）、`electron/worktree-merge.ts`（`mergeIntoBase`、`syncFromBase`、`abortSync`）、
  `electron/worktree-types.ts`、`electron/ipc/worktree.ts`、`electron/session-hub.ts`（`deleteSessions`、
  `worktreeFollowsArchive`、启动时检出回来）、`electron/git-worktrees.ts`（`cleanOldWorktrees`）；core
  `session/types.ts`（`worktree.base`、`worktreeError`）、`session/apply-record.ts`（`move` 清掉 `worktree`）；
  渲染进程 `src/features/modals/WorktreeMenu.tsx`、`useWorktreeState.ts`、`delete-session.tsx`、
  `src/features/composer/Composer.tsx`、`src/store/session-workspace.ts`；测试 `test/worktree-lifecycle.test.ts`、
  `test/worktree-merge.test.ts`、`test/git-worktrees.test.ts`、`test/ui/worktree-menu.test.ts`；探针
  `e2e/worktree-lifecycle-demo.ts`

## 背景

ADR-0048 让工作树按会话选，它的后半生没有做：

- 删除、归档会话不回收工作树，`~/.plume/worktrees` 只增不减。
- 自动清理（`cleanOldWorktrees`）认不出哪些是 Plume 建的：仓库的任何链接工作树都可能被收，只放过内存里正在跑的
  会话，而且带 `--force`，里面没提交的改动跟着没了。
- 工作树里做完的事回不到主分支，主分支上的新提交也进不来——只能自己开终端敲 git。
- 建不成工作树时对话里出一条提示。这件事在这个会话的整个生命里都成立（它改的是你自己的检出），提示说一次就被
  后面的对话推上去了。

## 决定

贯穿全部的一条：**分支比目录活得久。** 工作树是分支的一个检出，提交了的东西都在分支上，目录可以收走、再原样
检出回来。唯一会丢的是没提交的改动，没人点头就不丢。

**一、状态读自 git。** `worktree:state` 给出分支；基分支——切出时记下的 `worktree.base`，旧会话没记就按
`origin/HEAD` → `main` → `master`；领先、落后；没提交的文件数；是不是停在一次同步的中途；冲突的文件。

领先落后**不计合并提交**（`rev-list --no-merges`）。同步会在工作树的分支上留一个合并提交，合回去会在基分支上
留一个；计进去的话，刚合完的工作树显示「落后 1」，刚同步完的两个提交显示「领先 3」。

输入框上，工作树会话的分支 chip 换成工作树 chip：⑂、分支名、`↑2 ↓1`，同步停在冲突上时多一个琥珀色记号；目录被
收走时变灰。它在打开会话、一轮结束、窗口回到前台时重读，不轮询。这颗 chip 不能切分支：工作树就是它的分支。

**二、收回与检出回来。**

- **删除会话**：目录收走；分支上的提交全在基分支里（`merge-base --is-ancestor`）时分支一起删，否则分支留着。
  目录里有没提交的改动就不收。删除确认框读一次状态，把会留下的说出来。所有删除——单删、清空已归档、按日期清理——
  都经 `deleteSessions`，收回就放在那里。
- **归档会话**：同上。归档有三条路——窗口、手机、会话按吩咐归档自己（ADR-0049）——都在存储记下之后调
  `worktreeFollowsArchive`。上游只在窗口那一条上收，后两条会把目录留下。
- **取消归档**：在原来的路径检出回来——分支在就从分支，不在就从基分支新切。是原路径而不是今天的布局：会话自己的
  历史里按绝对路径提到文件。
- **会话启动时目录不在**：同样检出回来；检不出来就退回项目目录里跑，并记下原因（第四条）。
- **自动清理**只认分支是 `plume/session-*`（改名前是 `lyra/session-*`）的链接工作树，只收没有未归档会话在用的、
  干净的；不带 `--force`；分支留着。认不认得出是问 git 的（`git worktree list`），不看目录名。
- **手动把工作树会话移到别的项目**：`move` 清掉 `worktree` 字段——它不再在那棵工作树里跑，侧栏也不该再按原项目
  归组。

**三、合回去与同步进来**，都在工作树 chip 的菜单里。

- **合并到基分支**：先要求提交。
  - 基分支检出在项目目录里：在那里 `merge --no-ff`；有冲突立刻 `merge --abort`，人工作的检出里不留半截合并。
  - 基分支哪里都没检出：`merge-tree --write-tree` 算出结果，`commit-tree` 提交，带旧值 `update-ref` 挪分支——
    中间有新提交落进来就失败，而不是把它盖掉。
  - 检出在另一个工作树里：拒绝，说出在哪。
  - 冲突的结果说出文件和下一步：先从基分支同步，在工作树里解决之后再合并。
- **从基分支同步**：在工作树里 `merge`。冲突留在工作树里；菜单列出文件，给两条路——**交给这个对话解决**，或者
  **放弃这次同步**（`merge --abort`）。
- 会话在跑时两样都拒绝。都不推送。结果写在菜单底部；合并成功后多一行「归档这个对话」。

**四、建不成工作树，要一直说。** 原因记在会话上（`SessionMeta.worktreeError`），输入框上一个琥珀色提醒，点开是
说明和 git 的原话。取代 ADR-0048 第四条的对话内提示。

顺带修掉的：删除确认框打开约 420ms 后侧栏的悬停卡片盖在它上面。行的菜单和确认框是 React 意义上行的子节点，指针
落到确认框的遮罩上被算作进入了这一行；现在只认指针真的进到行自己的 DOM 里。

## 没做的

- 改版前（`6c26f11c` 之前）建在仓库旁边、没有 `worktree` 字段的工作树会话不归位，仍在各自的分组里，目录也不在
  窗口的白名单里。上游 `3c065249` 做了启动时归位；本机没有这样的会话，等有人遇到再移植。
- 推送、开 PR；选基分支；界面上丢掉没提交的改动（`reclaimWorktree` 有 `discardUncommitted`，不给）。
- 手机端没有工作树菜单。
