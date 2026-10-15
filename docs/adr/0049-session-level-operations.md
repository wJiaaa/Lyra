# ADR-0049：会话级操作——建议新会话由人点了才开始，归档自己等这一轮说完再归

- 状态：已采纳
- 日期：2026-10-14（移植自上游 kittors/Lyra main 的 ADR-0039，v0.9.27 之后）；2026-10-15 修订第 8 条，加第 9、10 条
- 相关：desktop `electron/session-ops.ts`（两件工具与 `archiveAfterTurn`）、`shared/session-suggestion.ts`、
  `electron/session-hub.ts`（注入与观察）、`electron/prompt-input.ts`、`electron/create-session.ts`、
  `src/store/turn-slice.ts`（`startSession`）、`src/store/session-suggestions.ts`、
  `src/features/environment/SuggestionsSection.tsx`、`src/features/conversation/SessionSuggestionCard.tsx`、
  `electron/session-report-back.ts`、`src/features/conversation/DeliveryRow.tsx`、`src/lib/sidebar-grouping.ts`
  （`nestSpawned`）、`src/features/sidebar/SessionRows.tsx`；core `session/types.ts`（`SessionMeta.spawnedFrom`）、
  `runtime/session-deliveries.ts`；测试 `desktop/test/session-ops.test.ts`、`desktop/test/session-report-back.test.ts`、
  `desktop/test/ui/session-suggestions.test.ts`、`core/test/session-report-delivery.test.ts`；指南 [内置能力 › 会话级操作](../guide/capabilities.md#会话级操作)；
  [ADR-0040](0040-session-messaging.md)、[ADR-0048](0048-worktree-per-conversation.md)

## 背景

参照 Claude Code 桌面版：做手头这件事时看到另一件值得单独做的事，可以在当前会话里建议一个新会话去做；也可以
让当前会话做完后自己归档自己。两件都是对**对话本身**的操作，不是对工作区的——下面每一条取舍都从这里来。

## 决定

1. **桌面端宿主工具，和会话间消息放在一起。** 两件工具写在 `electron/session-ops.ts`，由 `session-hub.ts` 经
   `extraTools` 注入，和 `peer-tools.ts`（ADR-0040）同一条路；命令行不传，天然没有。上游把工厂放在 core，这里
   照本仓库已有的做法放在主进程：工具描述、宿主回调都只有桌面端用得上。

2. **`spawn_session` 只提建议，立刻返回，不审批。** 参数是卡片标题（≤60 字，按字数算）、一两句说明、新会话
   的第一条消息（必须自足）。返回的话写明「什么都还没开始、人点了才开始、继续手头的事」——一张在等点击的卡片，
   从模型那边看和一件正在进行的事没有区别，不说清楚它会等。卡片本身就是同意，所以不再弹一道审批。卡片要的
   三样放在工具结果的 `details` 里（形状在 `shared/session-suggestion.ts`），日志原样保存，重开会话卡片还在。

3. **「开始」不切走当前对话。** 抽出 `send` 里建会话的三步（列进侧栏并标成在跑、主进程接下这一轮后换上权威的
   meta、没接下就标成失败），`send` 和新的 `startSession` 共用；`startSession` 不碰 `activeSessionId`，新会话在
   侧栏里自己在后台跑。目录取提建议那个对话的**项目**（`sessionHome`，ADR-0048）。

4. **「已开始」记在新会话身上，不记在卡片身上。** `SessionMeta.spawnedFrom = { sessionId, toolCallId }`，建会话时
   随 `initial` 下去、写进 meta。卡片按「会话列表里有没有一条的 `spawnedFrom` 指着我」判断自己是「开始」还是
   「已开始 · 打开」；会话列表本来就推给每个窗口、重启后从库里读回，不需要另一份存储、不需要新的 IPC。比对要连
   `sessionId` 一起：分叉出来的对话带着同一个调用 id。新字段要过 `prompt-input.ts` 那道逐字段的白名单，漏掉就会
   在主进程门口被悄悄丢掉，有测试专门守它。× 只是这台机器上收起来（localStorage 按调用 id 记）。

5. **`archive_session` 不能在工具里当场归档。** `sessions:setArchived` 先 `disposeSession`，处置会 abort——砍掉的
   正是还在等这个工具返回的那一轮，最后一条结果落不进去，收尾报 `aborted`。所以工具只交一张条子给宿主、返回
   `terminate: true`（工具一返回这一轮就以 `done` 结束，说完的话要写在调用之前）；主进程在 `broadcast` 里看见
   这个会话的 `agent_end(done)` 之后才归档，界面经会话变更自己离开被归档的当前会话。放掉会话要等它**闲下来**：
   `agent_end` 之后 `running` 还要真一段（收尾的判断、排在后面的话），这时候 dispose 一样是 abort。等的时候人要是
   把它取消归档了，就不放。这一轮以 `aborted`/`error` 收尾就不归档，条子作废。

6. **子代理和侧边聊天拿不到。** 两件都标 `sessionOnly`，子代理的工具表本来就筛掉它们；侧边聊天不带 `extraTools`。
   子代理不是一个对话：它的 `ctx.sessionId` 是 `<父id>:sub:<id>`，提的建议画不出来，要归档归掉的是派它来的人的
   对话。`archive_session` 自己再认一次 `:sub:`，挡住别的路子把工具放回去。

7. **建议问输入框问的那个问题，用自己的标题，说出它开的会话在做什么。** 「开始」旁边是输入框上那个 ⑂ 开关
   （`WorktreeToggle`，在 `ui/inputs/`：两个功能域都要它）；新会话的名字是建议的标题（`initial.title`，记作
   `titleSetByUser`，不被第一轮按首条消息改掉）；开始以后读侧栏行首那份 `activity`，说进行中、已完成、没跑完。

8. **卡片画在对话里调用的位置，环境卡片做第二个入口。**（2026-10-15 修订）最早这一条是「建议放在环境卡片里，
   对话里只留一行」：建议不拦着这一轮（第 2 条），模型提完接着干活，卡片会被顶到几屏之上，所以「开始」挪进了
   不随对话滚动的环境卡片，对话里只在整轮末尾留一行记录（`SessionSuggestionNote`）。用下来的问题是：那一行挂在
   整轮的回答下面，像是凭空多出来的一句；要开始得先点它、再去右上角找，建议本身反而离提出它的那句话最远。

   现在卡片站在调用的位置、自成一行（`grouping.ts` 的 `shows`，和 `preview` 的页面同一条路），不和前后的工具
   折在一起；参数还在写时标题先出来、「开始」按不动，写完即可开始。开始以后缩成一行，骨架和派出去的子智能体
   一样（`FlowRow`，行首是新会话的图标），点了过去。在跑由摘要上的扫光表示，行尾只在没跑完时写一句；不放
   侧栏那枚状态点、不写「进行中 / 已完成 / 已开始」——和扫光重复，「已开始」（看过之后状态清掉剩下的那句）
   更是什么都没说。当初「会被顶走」的理由仍然成立，但现在有两样
   兜着：开出来的会话挂在侧栏里提建议的那一行下面（第 10 条），环境卡片那一节也保留——还没处理的照旧由环境
   按钮上的圆点提醒，在那里也能开始。两处的「开始」那一排是同一个组件（`SuggestionStart`），读同一份状态：
   建议从工具结果读，开没开始从 `spawnedFrom` 读，收起记在 `store/session-suggestions.ts`（localStorage）。

   没有放在输入框上方：那里（子 Agent 那条栏、排队的消息）回答「此刻在发生什么」，是要立刻看到的；建议是
   有空再看的事，不该和它们抢那一行。

9. **交回主会话：默认关，由模型按需打开，只交第一轮。** `spawn_session` 多一个 `report_back`，卡片上对应一个
   「交回这里」开关，默认取模型给的值，人能改；选中的值随 `spawnedFrom.reportBack` 写进新会话的 meta（同样要过
   `prompt-input.ts` 的白名单）。开始以后，只要第一轮还在跑，卡片缩成的那一行后面也挂着这个开关
   （`sessions:reportBack`）——默认关，人看着它跑起来才意识到结果要用，不该只能停掉重开。主进程以内存里改过的
   那一份为准，写 meta 的那一拍里第一轮恰好结束也照新的交。新会话第一轮结束时，主进程（`session-report-back.ts`，
   挂在 `broadcast` 上，和归档同一处）把 meta 换成 `{ sessionId, toolCallId, settled: true }`——去掉
   `reportBack`，记下第一轮已经结束，开关随之消失、晚到的改动被拒——再把它最后那段回复送进提建议的那个会话：走 core 里子代理结果
   那条送达（`SessionDeliveries`，`receiveSessionReport`），忙着就插进这一轮、闲着就开一轮，界面画成一行
   「来自新会话 · 标题」（`DeliveryRow` 的 `kind: "session"`）。

   默认关，是因为交回要叫醒主会话多跑一轮。顺手发现的事（删死代码、补文档）交回来没有用；结果会改变手头
   这件事的才值得。只交第一轮：那是卡片交给它的事，之后人在它里面接着聊，每轮都往回送就是拿别人的对话去
   叫醒提建议的那个。被人停下的那一轮不交（停下是人的决定），出错、跑到上限的交，标成没跑完。主会话已归档
   就不叫醒。

10. **侧栏里挂在提建议的那一行下面。** 交出去的后续工作是它出自的那件事的一部分，并排列着读起来像无关的
    两个对话。`nestSpawned` 在分组之后把有 `spawnedFrom` 的会话挂到父会话下面，只在同一个列表里挂：父会话
    被置顶、归档，或者在别的分组里，子会话就留在原地单独一行，不会跟着一个不在场的父会话消失。不放进
    `groupSessions`，因为归档页和 `listed-projects` 也用它分组，那两处没有地方挂子行。子行缩进一格，一条
    短短的「└」画在这一行自己的框里，对着父会话状态点的位置，不往上连到父会话（那样会越出这一行的悬停
    底色）；它跟着父会话走，不参与拖拽重排。收起的分组数会话时把子行也算上。

## 没做的

- **归档那一轮后面还排着话**：它会在已归档的会话里接着跑完（dispose 等它），界面已经离开了。真碰到再说。
- **手机上点「开始」**：走同一份界面、同一条 `sessions.create`，没有在手机上单独验过。
