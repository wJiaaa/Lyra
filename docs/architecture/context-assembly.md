# 上下文组装与统计

主会话的组装入口是 `runtime/session-turn.ts`。规则、技能、记忆、环境和可用能力经
`runtime/prompt-context.ts` 加载，由 `prompt/system.ts` 产出一份提示词和段落来源。
每段记录来源、字符范围，以及适用时的文件路径和截断标记。
段落用字符范围引用同一份字符串，日志不重复保存正文。

借鉴 ZCode 的结构化来源与预算管理，保留 Lyra 的 system 注入语义、项目规则继承和
provider 接口。provider 缓存由各适配器处理。

## 缓存前缀

- system prompt 在会话内冻结。每轮仍按磁盘现状生成一份，但发出去的是冻结的那份；两者按段落
  （`PromptSource`，段落 id → 文本）比对，改了的段作为一条 `synthetic` 用户消息接在历史末尾并写进
  日志，开头的字节不变（`prompt/update.ts`、`session-turn.ts` 的 `settlePrompt`）。比对基准是模型
  此刻读到的各段：冻结那份叠上它看得到的历史里每一条增量，所以同一处改动只发一次，调上去又调回来
  也会补发。新增段落只要 `prompt.add` 一个新来源就纳入冻结与比对。
- 增量消息是 `<system-update>` 包着若干 `<section-update id="…">`，开头说明它来自运行时、不是用户
  发言、覆盖开头的同名段落；正文里的这两个标签和 `<session-summary>`、`<dropped-history>` 会被中和。
  压缩边界只认以这两个记号开头的合成消息，钩子上下文、子代理报告里引用到的同名标签不算边界。结构化的改动存在
  `promptUpdate` 字段里，重启后不解析正文。三条协议都按普通用户消息发送，不依赖中途 system 消息。
- 冻结的那份不另存：每轮发出的 system prompt 本来就记为 `context` 事件，重启取最近一条、去掉中间件
  追加的部分即得原样字节。压缩（有边界）之后作废，下一轮按现状重新生成；撤回截掉的上下文跟着失效，
  退回更早那条，截到第一轮之前则重新生成。中间件整段替换过、或老日志没有段落信息时，重启后重新生成。
  压缩保留尾部里的旧增量不删除（会改变 `kept` 计数），它和新开头一致，只是重复。
- system prompt 不放随时间变化的文本：日期在 `<env>` 日期块里，项目记忆标绝对日期而不是「几天前」。
- 主会话的 `<env>` 日期块不进日志，由循环在每次请求时按历史渲染（`AgentRunConfig.environment`）：
  跟在第一条人说的消息后面，之后只在日期变了的那条后面再出现，日期取消息自己的时间戳，同一份历史
  每次渲染出同样的字节。不接在最末尾：那样它永远是最后一条用户消息，DeepSeek 会丢掉之前各轮的推理，
  上一轮的输出也进不了缓存。
- 子代理把带日期块的历史原样存下续跑，不开这个选项；隔天续跑时新的日期块跟在这次的开场消息后面。
- 每次模型请求带 `AgentRunConfig.cacheKey`，协议层据此发缓存路由键：主会话用会话 id；子代理用
  自己的运行 id（`<会话 id>:sub:<短 id>`，续跑沿用，讨交接那一轮也用它）；侧聊用 `<会话 id>:side`
  （同一会话后开的侧聊是 `<会话 id>:side:<侧聊 id>`），不与主会话、也不互相混用，因为各自前缀不同。压缩摘要、标题生成、记忆抽取是一次性请求、前缀不复用，不带。
- 项目记忆与用户记忆按会话冻结，压缩（有边界）、撤回、重新载入时重读；`learn` 和后台抽取不再
  逐轮改 system prompt。人在设置里删改记忆立即作废快照；手工编辑文件、其他会话的 `learn` 等到
  下一次重读。重读到的变化在压缩时直接进新开头，其余时候作为增量接在末尾。`learned.md` 里没有时间戳的手写条目按文件修改时间标日期，同一份文件产出同一份字节。
- 什么活值得派写在 `task` 工具描述里，是固定文字，不随推理等级或设置变。提示词里只有子代理名单
  和一句并发上限；上限单独是 `delegation` 段，改 `maxConcurrentSubAgents` 时走增量，数字和闸门宽度
  都由 `normalizeMaxConcurrentSubAgents` 从同一个设置算出。
- 已经发给模型的内容在会话中途不改写，压缩是唯一有意重写前缀的时候；不按缓存有效期判断「改写
  是否免费」。新结果第一次发出前由 `AgedToolPruner` 定下视图（清空「无结果」、超过
  `FRESH_RESULT_MAX_CHARS` 剪成头尾），只看结果本身，重建历史时——包括重启后——得出同一份；
  `artifact://` 地址按内容取。压缩阶段的剪枝和摘要保留尾部由它按日志原文记住，下一轮换回同一份；
  这些视图另写一条 `views` 记录，重启或换模型后第一次请求前放回，不按原文重发。被后来的读取或编辑覆盖的结果只在压缩时清。后台子代理的送达消息按同一条线
  剪，一份报告一个文本块，只剪超长的那份；`read artifact://…` 接受 `offset`/`limit`/`char_offset`，
  超过单条上限的内容也按窗口返回，被剪掉的中段取得回来。
- `read` 自己按字数截断（约 35k 字符），只把返回的行记为已读，并给出续读位置；超过
  `FRESH_RESULT_MAX_CHARS` 的新结果会在模型看到之前被剪成头尾。压缩阶段对模型还没看过的结果
  用同一条线，不再剪到 8k。
- 摘要请求的输入预算按实测 usage 与字符估算之比校正（只往保守方向），被压短的工具调用参数对象
  与原文同源，Anthropic 协议也能看到路径和命令。

## 缓存未命中诊断

`runtime/cache-diagnostics.ts` 的 `diagnoseCache` 对一条请求序列逐次算出本该命中而没命中的
token 和多花的钱，用来验收上面这些前缀修复、并定位前缀在哪一次请求被打断。主会话与每个子代理
各是一条序列，缓存前缀互不相干。`pnpm audit:sessions` 第 10 节在本机真实会话上汇总它；设置页
「用量」的「缓存未命中」一节按区间汇总同样的结果：扫描器（`electron/usage-scan.ts`）逐条推进
`diagnoseRequest`，每条序列的进度（`CacheDiagnosisState`）存进增量缓存，日志长了接着诊断。

- **期望前缀**：`min(上一次请求的 input + cacheRead + cacheWrite, 这一次的同一总量)`；
  未命中 = 期望 − 实际 cacheRead。Usage 四个桶互不重叠，所以只报 cacheRead 的服务商也适用。
  用量取这一次请求自身的 `lastAttemptUsage`，没有就取 `usage`（`requestUsage`）：`usage` 是含流内
  重试的计费总额，拿它当前缀长度或窗口占用，一次重试就会算成两倍。`measureTotal` 同理。
- **多花**：未命中的 token 按这一次 input 与 cacheWrite 两桶的加权实付单价，减去缓存读单价。
  费率只取日志里请求当时存下的 `cost.rates`；没有（模型没配定价）就只报 token、不报钱。
- **原因**，按这个顺序判定：没有上一次 → 首个请求；未命中 ≤ 1024 token → 命中（缓存按块计，
  前缀完全稳定的请求也会差出几十个 token）；跨过压缩或撤回边界 → 前缀有意重写，不算打断；
  服务商/模型变了 → 换模型；这个服务商/模型从未报告过任何缓存 → 无从判断、不计未命中；
  其余按回复上的前缀指纹分（见下一条）：第一处变化在工具定义 → 工具变了，在系统提示词 → 提示词变了，
  在某条消息 → 改写了已发出的消息；量过而前缀没变 → 服务商没读到（清掉、路由或过期）；没有指纹
  （旧日志、重启后的第一次请求），或第一处变化在请求参数（thinking 档位等，有的会让缓存失效、有的
  不会）→ 原因不明。
- **不按缓存有效期归类**。各家留多久不同，中转更说不准：本机 gpt-6-astra 中转空闲 19 分钟仍全部命中，
  DeepSeek 空闲 527 秒后 12.8 万 token 前缀只读到 2,048。按一个猜的时长把未命中记成「过期」，会把
  真打断藏起来，所以只把两次请求开始时间的间隔照实记在 `idleMs`，由看的人对照。
- **本地前缀变没变**：每次请求把最终请求体按工具定义、系统提示词、请求参数、逐条消息切段算哈希（去掉
  协议放在工具、system 块和内容块上的 `cache_control` 断点；请求参数不含逐次重算的输出上限、流式开关、
  路由键和模型名；开头三段每次都占位，缺了记空，关掉 thinking 或工具全断开时变化不会错记到后一段），和同一会话上一次比，第一处不同的段及其前后长度记在回复的 `prefix` 上，不存正文
  （`ai/prefix-fingerprint.ts`）。Chat Completions 的系统提示词是开头那条 `system` 消息，同样记成
  `system` 段，不然改提示词会被当成改写历史。工具定义在三条协议里都排最前，改一处整段重算；会话中途
  变它的是 MCP 连上/断开、插件工具、`learn` 随项目记忆开关出现或消失，以及升级后内置工具的描述。
- **已知误报**：DeepSeek 的缓存是请求结束后异步建的，两次请求隔几秒时后一次可能只读到更早的
  那份缓存，差出一千多 token、落进「服务商没读到」。榜单按未命中量排序，真正的打断排在它前面。

参考 pi 的 `cache-stats.ts`（逐轮比较上一轮输入、只报 cacheRead 的服务商在报告过缓存之后才计
整段未命中、压缩后重置）与 ZCode 的用量统计（摘要请求不进命中率，只读持久化的原始 usage）。
没照抄的：pi 的费用从本条消息的 cost 反推，没有存费率就是 0；「是否报告过缓存」按整段扫描粘住，
而中转服务商下同时有会缓存和不会缓存的模型，这里按服务商/模型分开记；pi 在压缩后直接不算，
这里仍算出重写的代价、只是原因归到压缩。

## 缓存用量

三条协议的 usage 解析都走 `ai/usage-fields.ts` 的 `USAGE_DIALECTS`：每条协议、每个桶
（input / output / cacheRead / cacheWrite / reasoning）一列候选字段，按优先级排，每行写明出处。
新增一个服务商变体只在对应列表里加一行，适配器不动。

- **input 含不含缓存是协议语义**：两条 OpenAI 协议的 `prompt_tokens` / `input_tokens` 含命中与写入，
  要扣掉；Anthropic 的 `input_tokens` 不含。DeepSeek 直接报了未命中数（`prompt_cache_miss_tokens`），
  有它就不做减法。含缓存的协议里，总输入与它含着的缓存桶同帧一起更新，否则扣的和存的不是同一个数。
- **同一个桶的几个字段是别名**，取第一个大于 0 的。pi 用 `a ?? b ?? c`，会停在中转在标准位置填的
  占位 0 上；ZCode 经 AI SDK 只认 `prompt_tokens_details.cached_tokens`，DeepSeek 与 Kimi 顶层的命中
  都记成 0。
- **没出现的桶不动**：Anthropic 的 `message_delta` 通常只带 `output_tokens`。
- 已覆盖的变体：OpenAI、OpenRouter（`cache_write_tokens`）、DeepSeek（hit / miss）、Kimi（顶层
  `cached_tokens`、`prompt_tokens_details.cache_write_tokens`）、Mistral 的两种写法、LiteLLM 转发
  Anthropic 时的顶层 `cache_*_input_tokens`、阿里云百炼显式缓存的 `cache_creation_input_tokens`。
  用例在 `test/usage-fields.test.ts`，一个变体一组。

## 缓存路由键

`RequestOptions.cacheKey` 是同一条对话前缀的稳定标识（主会话传会话 id，子代理各传区分开的 id）。
缓存命中按机器算，路由键让服务商把这些请求送到同一处。`ai/cache-routing.ts` 不按端点区分、没有配置项，
每个请求都带同一套，做法同 ZCode 并补上它没有的两项：

| 协议 | 带什么 | 依据 |
| --- | --- | --- |
| Responses / Chat Completions | 请求头 `x-session-id`（≤256） | OpenRouter 的 sticky routing 键；ZCode 对所有请求都带 |
| | 请求头 `session_id`（≤256） | Codex CLI 发的会话头；sub2api 一类号池选上游账号先看它，都没有就随机分 |
| | 请求体 `prompt_cache_key`（≤64） | OpenAI 官方字段，Kimi 与多数中转也认 |
| Anthropic Messages | 请求体 `metadata.user_id` | Claude Code 的 JSON `{device_id, account_uuid, session_id}`，同 ZCode；Claude 号池类中转按其中的 `session_id` 粘住账号。缓存本身靠 `cache_control` |

- **严格端点**：未知字段被拒且错误串点名 `prompt_cache_key` 时，`request-params-compat.ts` 学到
  `cache-key`，撤掉重发一次，本进程内这个模型不再带；两个会话头照带。请求头不参与学习：未知请求头各家
  都是忽略。拒了却不点名字段的端点学不到，这类端点目前没有手动关的开关。
- **`device_id`** 由主机名和用户目录算出的 64 位十六进制摘要，不存盘，同一台机器每次启动都一样。
- **要求专门会话头的服务商**由 `sessionHeaders` 按地址写死：目前只有 OpenCode Go
  （`opencode.ai/zen/go`）的 `x-opencode-session`，缺了直接 400，做法同 ZCode `opencode-session.ts`。
  三种协议都带；没有 `cacheKey` 的一次性请求（压缩、测试连接）给随机 id 而不是不带。
- **没有 `cacheKey`** 的请求上面几项都不带（`x-opencode-session` 除外），和从前一样。
- **超长或含非 ASCII 的键**压成「可读前缀-摘要」，不截断：pi 截到 64 字符，共享长前缀的主会话与
  子代理键会变成同一个。请求头只能是可见 ASCII，否则 `fetch` 直接抛错。

## 请求与统计共用的数据

```text
项目规则、技能、记忆、环境
          ↓
    提示词与来源段落
          ↓
     turn 中间件
          ↓
  context 事件保存实际提示词、段落范围和工具 schema
          ↓
  历史裁剪／压缩 → 请求快照 → provider 编码与发送
                      ↓
               上下文面板的统计
```

- 中间件追加提示词时保留原段落并标记扩展内容；完整替换时只记录扩展来源，避免把删除的
  规则算进统计。工具 schema 使用过滤之后真正发送的集合。
- 每次模型请求前，在裁剪、压缩及请求拒收恢复之后捕获上下文，后续已提交消息继续计入。
  手动压缩、恢复和撤回会使旧请求快照失效。
- 重启后复用日志中的 context 事件，避免磁盘上后来改变的规则影响旧请求的统计。
  旧事件没有段落信息时只报告已有提示词整体；没有 context 事件的会话走共用加载器预估。
- 统计中的段落大小仍是字符估算；有效 provider usage 决定总量，历史部分承担估算误差。
  provider 的序列化开销、缓存命中率和实际费用不能由段落字符数直接证明。

## 固定上下文预算

| 来源 | 规则 |
| --- | --- |
| 每份项目指令文件 | 正文最多 100 KiB UTF-8；在完整字符边界截断，附文件路径及读取全文的提醒 |
| 技能描述 | 每条最多 250 个 Unicode 字符；正文仍按需加载 |
| 技能目录 | 超过 20,000 字符时去掉描述，保留所有名称和路径；这是软预算，名称与路径本身仍可能超出 |
| 项目记忆 | learned 与 inferred 合并正文最多 200 行、25,000 字符，另附截断提示；信任说明及 XML 闭合标签保留 |

预算限制模型收到的副本，不改写原文件。项目规则继续从工作目录向仓库根收集，按祖先到子目录
排序；同目录保持 LYRA.md、AGENTS.md、CLAUDE.md 的既有优先级。用户全局自定义指令和记忆
沿用现有规则，不作为项目记忆裁剪。

上下文窗口的 80% 压缩触发线、裁剪节奏、任务事实快照与 recall 恢复机制见
[成本与停止机制](agent-cost-and-stopping.md)。本次组装调整不据历史重放宣称费用或完成率改善。

验证入口：`packages/core/test/context-assembly.test.ts`、`prompt-freeze.test.ts`，以及 system prompt 快照、上下文计量、
记忆、日志、压缩、撤回和 provider 相关测试。`scripts/audit-regression.mjs` 登记了组装守卫。
